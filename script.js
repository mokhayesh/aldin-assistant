// Prefer same-origin: serve this UI from the same host:port as llama.cpp.
// Then these endpoints resolve correctly from any client on your network.
const API_BASE = `${window.location.origin}/v1`;
const API_URL = `${API_BASE}/chat/completions`;
const MODELS_URL = `${API_BASE}/models`;

// llama.cpp server key (matches --api_key)
// Tip: set once in DevTools console: localStorage.setItem('aldin_api_key','aldin-local-key')
const API_KEY = localStorage.getItem("aldin_api_key") || "aldin-local-key";
const MODEL = localStorage.getItem("aldin_model") || "aldin-mini";

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("user-input");

const avatarWrapper = document.getElementById("avatar-wrapper");
const avatarStatus = document.getElementById("avatar-status");
const avatarVideo = document.getElementById("avatar-video");

const wakeToggle = document.getElementById("wake-toggle");
const voiceToggle = document.getElementById("voice-toggle");
const ttsToggle = document.getElementById("tts-toggle");

let conversation = [
  {
    role: "system",
    content: "You are Aldin-Mini, a helpful, concise home AI assistant.",
  },
];

let ttsEnabled = true;
let wakeEnabled = false;
let recognition = null;
let listeningForWake = false;
let speakingUtterance = null;

// --- Futuristic voice layer (synthetic undertone) ---
// SpeechSynthesis audio cannot be directly processed, so we layer a subtle synth texture
// while the assistant is speaking (kept intentionally low-volume).
let voxCtx = null;
let voxOsc = null;
let voxGain = null;
let voxNoiseSrc = null;

function startSynthVox() {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!voxCtx) voxCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (voxCtx.state === "suspended") voxCtx.resume().catch(() => {});

    voxOsc = voxCtx.createOscillator();
    voxOsc.type = "sawtooth";
    voxOsc.frequency.value = 118;

    const bufferSize = 2 * voxCtx.sampleRate;
    const noiseBuffer = voxCtx.createBuffer(1, bufferSize, voxCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = (Math.random() * 2 - 1) * 0.12;
    voxNoiseSrc = voxCtx.createBufferSource();
    voxNoiseSrc.buffer = noiseBuffer;
    voxNoiseSrc.loop = true;

    const noiseFilter = voxCtx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 950;
    noiseFilter.Q.value = 0.9;

    voxGain = voxCtx.createGain();
    voxGain.gain.value = 0.0;

    const hp = voxCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 140;

    voxOsc.connect(voxGain);
    voxNoiseSrc.connect(noiseFilter);
    noiseFilter.connect(voxGain);
    voxGain.connect(hp);
    hp.connect(voxCtx.destination);

    const now = voxCtx.currentTime;
    voxGain.gain.cancelScheduledValues(now);
    voxGain.gain.setValueAtTime(0.0, now);
    voxGain.gain.linearRampToValueAtTime(0.03, now + 0.08);

    voxOsc.start();
    voxNoiseSrc.start();
  } catch {
    // ignore
  }
}

function stopSynthVox() {
  try {
    if (!voxCtx || !voxGain) return;
    const now = voxCtx.currentTime;
    voxGain.gain.cancelScheduledValues(now);
    voxGain.gain.setValueAtTime(voxGain.gain.value, now);
    voxGain.gain.linearRampToValueAtTime(0.0, now + 0.12);
    setTimeout(() => {
      try {
        voxOsc?.stop();
        voxNoiseSrc?.stop();
      } catch {}
      voxOsc = null;
      voxNoiseSrc = null;
      voxGain = null;
    }, 200);
  } catch {
    // ignore
  }
}



/* ---------------------------------
   LOAD VOICES
----------------------------------*/
speechSynthesis.onvoiceschanged = () => {};

/* ---------------------------------
   FEMININE FUTURISTIC VOICE PICKER
----------------------------------*/
function getFeminineFuturisticVoice() {
  const voices = speechSynthesis.getVoices();

  // Priority list of best feminine synthetic voices
  const preferred = [
    "Google US English",       // Chrome synthetic female
    "Google English",          // fallback
    "Microsoft Zira",          // Windows feminine voice
    "English United States",   // generic female variants
    "Female"                   // catch-all
  ];

  for (const name of preferred) {
    const match = voices.find(v => v.name.includes(name));
    if (match) return match;
  }

  // Fallback: any en-US voice
  return voices.find(v => v.lang === "en-US") || voices[0] || null;
}

/* ---------------------------
   UI MESSAGE HANDLING
----------------------------*/
function addMessage(role, text) {
  const div = document.createElement("div");
  div.classList.add("message", role);
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

/* ---------------------------
   AVATAR STATE CONTROL
----------------------------*/
function setState(state) {
  avatarWrapper.classList.remove("thinking", "speaking", "listening");

  if (state === "thinking") {
    avatarWrapper.classList.add("thinking");
    avatarStatus.textContent = "Thinking...";
  } else if (state === "speaking") {
    avatarWrapper.classList.add("speaking");
    avatarStatus.textContent = "Responding...";
  } else if (state === "listening") {
    avatarWrapper.classList.add("listening");
    avatarStatus.textContent = "Listening...";
  } else if (state === "greeting") {
    avatarStatus.textContent = "Hello";
  } else {
    avatarStatus.textContent = "Idle";
  }

  // Video avatar state machine (3 mp4s): rest / greeting / response
  const avatarVideo = document.getElementById("avatar-video");
  if (avatarVideo) {
    const restSrc = avatarVideo.dataset.restSrc || "assistant-avatar-rest.mp4";
    const greetSrc = avatarVideo.dataset.greetingSrc || "assistant-avatar-greeting.mp4";
    const respSrc = avatarVideo.dataset.responseSrc || "assistant-avatar-response.mp4";

    let nextSrc = restSrc;
    let loop = true;

    if (state === "speaking") {
      nextSrc = respSrc;
      loop = true;
    } else if (state === "greeting") {
      nextSrc = greetSrc;
      loop = false;
    } else {
      nextSrc = restSrc;
      loop = true;
    }

    if (avatarVideo.getAttribute("src") !== nextSrc) {
      avatarVideo.setAttribute("src", nextSrc);
      avatarVideo.load();
    }
    avatarVideo.loop = loop;
    avatarVideo.play().catch(() => {});

    if (state === "greeting") {
      const onEnded = () => {
        avatarVideo.removeEventListener("ended", onEnded);
        setState("idle");
      };
      avatarVideo.addEventListener("ended", onEnded);
    }
  }
}

// Play greeting once on first load
window.addEventListener("load", () => {
  setState("greeting");
});

/* ---------------------------
   TEXT-TO-SPEECH (FEMININE FUTURISTIC)
----------------------------*/
function speak(text) {
  if (!ttsEnabled || !window.speechSynthesis) return;

  if (speakingUtterance) {
    window.speechSynthesis.cancel();
  }

  const utter = new SpeechSynthesisUtterance(text);

  // Load best feminine futuristic voice
  const best = getFeminineFuturisticVoice();
  if (best) utter.voice = best;

  // Futuristic feminine tuning
  utter.pitch = 1.15;   // slightly higher, feminine + synthetic
  utter.rate = 1.02;    // smooth, calm pacing
  utter.volume = 1.0;

  speakingUtterance = utter;

  utter.onstart = () => {
    setState("speaking");
    startSynthVox();
  };

  utter.onend = () => {
    speakingUtterance = null;
    stopSynthVox();
    setTimeout(() => setState("idle"), 400);
  };

  window.speechSynthesis.speak(utter);
}

/* ---------------------------
   TYPING EFFECT
----------------------------*/
function typeOutText(element, fullText, speed = 18) {
  element.textContent = "";
  let i = 0;

  const interval = setInterval(() => {
    element.textContent += fullText[i];
    i++;
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (i >= fullText.length) {
      clearInterval(interval);
      speak(fullText);
      setTimeout(() => setState("idle"), 400);
    }
  }, speed);
}

/* ---------------------------
   SEND MESSAGE TO LLM
----------------------------*/
async function sendMessage(text) {
  const userMsg = { role: "user", content: text };
  conversation.push(userMsg);
  addMessage("user", text);

  setState("thinking");
  inputEl.disabled = true;

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: conversation,
        temperature: 0.7,
        max_tokens: 512,
        top_p: 1,
        n_predict: 256,
        stream: false,
        stop: null,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const assistantText =
      data.choices?.[0]?.message?.content?.trim() || "[No response]";

    conversation.push({ role: "assistant", content: assistantText });

    setState("speaking");
    const msgEl = addMessage("assistant", "");
    typeOutText(msgEl, assistantText);
  } catch (err) {
    console.error(err);
    addMessage("assistant", "There was an error talking to Aldin-Mini.");
    setTimeout(() => setState("idle"), 800);
  } finally {
    inputEl.disabled = false;
    inputEl.focus();
  }
}

/* ---------------------------
   CHAT FORM SUBMIT
----------------------------*/
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendMessage(text);
});

/* ---------------------------
   TTS TOGGLE
----------------------------*/
ttsToggle.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  ttsToggle.classList.toggle("active", ttsEnabled);
  ttsToggle.textContent = ttsEnabled ? "Voice: On" : "Voice: Off";

  if (!ttsEnabled && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
});

/* ---------------------------
   SPEECH RECOGNITION
----------------------------*/
function initRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = false;
  return rec;
}

voiceToggle.addEventListener("click", () => {
  // User gesture: allow AudioContext to start later for the synthetic voice layer
  try {
    if (!voxCtx && (window.AudioContext || window.webkitAudioContext)) {
      voxCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    voxCtx?.resume?.().catch(() => {});
  } catch {}

  if (!recognition) {
    recognition = initRecognition();
    if (!recognition) {
      alert("Speech recognition not supported in this browser.");
      return;
    }

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      addMessage("user", transcript);
      sendMessage(transcript);
    };

    recognition.onstart = () => {
      voiceToggle.classList.add("active");
      setState("listening");
    };
    recognition.onend = () => {
      voiceToggle.classList.remove("active");
      if (!wakeEnabled) setState("idle");
    };

    recognition.onerror = (event) => {
      voiceToggle.classList.remove("active");
      const msg =
        `Mic error: ${event.error}. ` +
        `If you're opening this from a different computer via http://10.x.x.x, Chrome may block speech recognition on insecure origins. ` +
        `Fix options: (1) use https, (2) open via http://localhost on the same machine, or (3) enable chrome://flags/#unsafely-treat-insecure-origin-as-secure and add ${window.location.origin}.`;
      addMessage("assistant", msg);
      if (!wakeEnabled) setState("idle");
    };
  }

  recognition.start();
});

/* ---------------------------
   WAKE WORD SYSTEM
----------------------------*/
wakeToggle.addEventListener("click", () => {
  wakeEnabled = !wakeEnabled;
  wakeToggle.classList.toggle("active", wakeEnabled);
  wakeToggle.textContent = wakeEnabled ? "Wake: On" : "Wake: Off";

  if (!recognition) {
    recognition = initRecognition();
    if (!recognition) {
      alert("Speech recognition not supported in this browser.");
      wakeEnabled = false;
      wakeToggle.classList.remove("active");
      wakeToggle.textContent = "Wake: Off";
      return;
    }
  }

  if (wakeEnabled && !listeningForWake) {
    startWakeLoop();
  } else if (!wakeEnabled && listeningForWake) {
    recognition.stop();
    listeningForWake = false;
    setState("idle");
  }
});

function startWakeLoop() {
  if (!recognition) return;

  listeningForWake = true;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.toLowerCase();

    if (transcript.includes("aldin")) {
      setState("listening");

      recognition.onresult = (event2) => {
        const query = event2.results[0][0].transcript.trim();
        addMessage("user", query);
        sendMessage(query);

        if (wakeEnabled) startWakeLoop();
      };

      recognition.start();
    } else if (wakeEnabled) {
      startWakeLoop();
    }
  };

  recognition.onend = () => {
    if (wakeEnabled) {
      recognition.start();
    } else {
      listeningForWake = false;
      setState("idle");
    }
  };

  recognition.start();
}