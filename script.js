const API_URL = "http://10.0.0.108:8871/v1/chat/completions";
const API_KEY = "aldin-local-key";

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
  } else {
    avatarStatus.textContent = "Idle";
  }
}

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
  };

  utter.onend = () => {
    speakingUtterance = null;
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
        model: "aldin-mini",
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

    recognition.onstart = () => setState("listening");
    recognition.onend = () => {
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