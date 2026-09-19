(() => {
  "use strict";

  const STORAGE_KEY = "pokerClockState";

  /* ----------------------------------------------------------------
   * Blind schedule generation
   *
   * Rule from the spec: a 200 kr buy-in starts at SB 1 / BB 5 (a 1:5
   * ratio, BB = buy-in / 40). That ratio is kept constant as a
   * function of buy-in. The growth rate is anchored to real time
   * rather than to the tournament length: the big blind reaches 20x
   * its starting value after GROWTH_ANCHOR_MINUTES of play (20x
   * because a 200 kr buy-in's BB of 5 should reach 100 after 5
   * hours). That rate is independent of how often levels change
   * (level length only decides how finely it's sampled), and of the
   * configured total tournament length. All blinds and antes are
   * rounded to whole numbers.
   * ---------------------------------------------------------------- */
  const GROWTH_ANCHOR_MINUTES = 300; // 5 hours
  const GROWTH_ANCHOR_MULTIPLE = 20; // BB(anchor) = BB1 * 20 (e.g. 5 -> 100)

  function generateSchedule({ buyIn, totalMinutes, lastBuyInMinutes, levelMinutes }) {
    const smallBlind1 = Math.max(1, Math.round(buyIn / 200));
    const bigBlind1 = smallBlind1 * 5;

    const levelSeconds = Math.max(60, Math.round(levelMinutes * 60));
    const numLevels = Math.max(1, Math.ceil((totalMinutes * 60) / levelSeconds));

    const growth = Math.pow(
      GROWTH_ANCHOR_MULTIPLE,
      levelSeconds / 60 / GROWTH_ANCHOR_MINUTES
    );

    const anteStartLevel = Math.max(2, Math.ceil(numLevels / 3));

    const levels = [];
    let prevBig = 0;
    let prevSmall = 0;
    for (let i = 1; i <= numLevels; i++) {
      let big = Math.round(bigBlind1 * Math.pow(growth, i - 1));
      if (big <= prevBig) big = prevBig + 1;
      let small = Math.max(1, Math.round(big / 5));
      if (small <= prevSmall) small = prevSmall + (i === 1 ? 0 : 1);

      const ante = i >= anteStartLevel ? small : 0;

      levels.push({
        level: i,
        small,
        big,
        ante,
        durationSeconds: levelSeconds,
        startSeconds: (i - 1) * levelSeconds,
      });

      prevBig = big;
      prevSmall = small;
    }

    const totalSeconds = numLevels * levelSeconds;
    const lastBuyInSeconds = Math.min(
      totalSeconds,
      Math.max(0, Math.round(lastBuyInMinutes * 60))
    );

    return { levels, levelSeconds, numLevels, totalSeconds, lastBuyInSeconds };
  }

  /* ---------------------------------------------------------------- */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore storage errors */
    }
  }

  function clearState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function formatHMS(totalSeconds) {
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function formatMS(totalSeconds) {
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /* ---------------------------------------------------------------- */

  let audioCtx = null;
  function playTone(freq, duration, type, volume) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      /* audio not available */
    }
  }

  // Short high bell for every blind increase.
  function playPling() {
    playTone(1568, 0.18, "triangle", 0.25); // G6
    setTimeout(() => playTone(2093, 0.22, "triangle", 0.18), 60); // C7
  }

  // Deep, longer bell for the moment buy-ins close.
  function playDong() {
    playTone(196, 0.9, "sine", 0.3); // G3
    playTone(98, 0.9, "sine", 0.2); // G2
  }

  /* ---------------------------------------------------------------- */

  const setupScreen = document.getElementById("setup-screen");
  const clockScreen = document.getElementById("clock-screen");
  const setupForm = document.getElementById("setup-form");
  const setupError = document.getElementById("setup-error");

  const levelLabelEl = document.getElementById("level-label");
  const totalElapsedEl = document.getElementById("total-elapsed");
  const totalRemainingEl = document.getElementById("total-remaining");
  const smallBlindEl = document.getElementById("small-blind");
  const bigBlindEl = document.getElementById("big-blind");
  const anteEl = document.getElementById("ante");
  const anteBox = document.getElementById("ante-box");
  const levelTimerEl = document.getElementById("level-timer");
  const progressFillEl = document.getElementById("progress-fill");
  const nextSmallEl = document.getElementById("next-small");
  const nextBigEl = document.getElementById("next-big");
  const nextAnteEl = document.getElementById("next-ante");
  const nextAnteWrap = document.getElementById("next-ante-wrap");
  const buyinStatusText = document.getElementById("buyin-status-text");
  const buyinCountdown = document.getElementById("buyin-countdown");
  const playersCountEl = document.getElementById("players-count");
  const extraBuyinsCountEl = document.getElementById("extra-buyins-count");
  const totalPotEl = document.getElementById("total-pot");

  const pauseBtn = document.getElementById("pause-btn");
  const buyinBtn = document.getElementById("buyin-btn");
  const nextLevelBtn = document.getElementById("next-level-btn");
  const prevLevelBtn = document.getElementById("prev-level-btn");
  const newGameBtn = document.getElementById("new-game-btn");

  let state = null;
  let tickHandle = null;
  let lastDisplayedLevel = null;
  let buyinsClosedAnnounced = false;

  function naturalElapsedSeconds() {
    const now = state.pausedAt || Date.now();
    return (now - state.startTimestamp - state.totalPausedMs) / 1000;
  }

  function effectiveElapsedSeconds() {
    return naturalElapsedSeconds() + state.manualOffsetSeconds;
  }

  function currentLevelIndex() {
    const elapsed = Math.min(
      effectiveElapsedSeconds(),
      state.schedule.totalSeconds - 0.001
    );
    const clamped = Math.max(0, elapsed);
    const idx = Math.floor(clamped / state.schedule.levelSeconds);
    return Math.min(state.schedule.numLevels - 1, Math.max(0, idx));
  }

  function jumpToLevel(idx) {
    idx = Math.min(state.schedule.numLevels - 1, Math.max(0, idx));
    const targetStart = idx * state.schedule.levelSeconds;
    state.manualOffsetSeconds = targetStart - naturalElapsedSeconds();
    saveState(state);
    render();
  }

  function setPaused(paused) {
    if (paused && !state.pausedAt) {
      state.pausedAt = Date.now();
    } else if (!paused && state.pausedAt) {
      state.totalPausedMs += Date.now() - state.pausedAt;
      state.pausedAt = null;
    }
    saveState(state);
    render();
  }

  function totalPot() {
    return state.config.buyIn * (state.config.players + state.extraBuyins);
  }

  function render() {
    const { schedule, config } = state;

    if (!state.started) {
      const lvl = schedule.levels[0];
      const nextLvl = schedule.levels[1];

      levelLabelEl.textContent = `Ready — Level 1 / ${schedule.numLevels}`;
      totalElapsedEl.textContent = formatHMS(0);
      totalRemainingEl.textContent = formatHMS(schedule.totalSeconds);

      smallBlindEl.textContent = lvl.small;
      bigBlindEl.textContent = lvl.big;
      anteEl.textContent = lvl.ante;
      anteBox.classList.toggle("zero", lvl.ante === 0);

      levelTimerEl.textContent = formatMS(lvl.durationSeconds);
      levelTimerEl.classList.remove("warning", "critical");
      progressFillEl.style.width = "0%";

      if (nextLvl) {
        nextSmallEl.textContent = nextLvl.small;
        nextBigEl.textContent = nextLvl.big;
        nextAnteEl.textContent = nextLvl.ante;
        nextAnteWrap.style.display = nextLvl.ante > 0 ? "inline" : "none";
      }
      nextLevelBtn.disabled = true;
      prevLevelBtn.disabled = true;

      const buyinsOpen = schedule.lastBuyInSeconds > 0;
      buyinBtn.disabled = !buyinsOpen;
      buyinStatusText.textContent = buyinsOpen ? "Buy-ins open" : "Buy-ins closed";
      buyinStatusText.className = buyinsOpen ? "buyin-open" : "buyin-closed";
      buyinCountdown.textContent = buyinsOpen
        ? `closes ${formatHMS(schedule.lastBuyInSeconds)} after start`
        : "";

      playersCountEl.textContent = config.players;
      extraBuyinsCountEl.textContent = state.extraBuyins;
      totalPotEl.textContent = `${totalPot()} kr`;

      pauseBtn.textContent = "Start Clock";
      return;
    }

    const idx = currentLevelIndex();
    const lvl = schedule.levels[idx];
    const nextLvl = schedule.levels[idx + 1];

    const elapsedInLevel = effectiveElapsedSeconds() - lvl.startSeconds;
    const remainingInLevel = lvl.durationSeconds - elapsedInLevel;

    const totalElapsed = Math.min(schedule.totalSeconds, Math.max(0, effectiveElapsedSeconds()));
    const totalRemaining = schedule.totalSeconds - totalElapsed;

    levelLabelEl.textContent = `Level ${lvl.level} / ${schedule.numLevels}`;
    totalElapsedEl.textContent = formatHMS(totalElapsed);
    totalRemainingEl.textContent = formatHMS(Math.max(0, totalRemaining));

    smallBlindEl.textContent = lvl.small;
    bigBlindEl.textContent = lvl.big;
    anteEl.textContent = lvl.ante;
    anteBox.classList.toggle("zero", lvl.ante === 0);

    const timerSeconds = Math.max(0, remainingInLevel);
    levelTimerEl.textContent = formatMS(timerSeconds);
    levelTimerEl.classList.toggle("warning", timerSeconds <= 60 && timerSeconds > 20);
    levelTimerEl.classList.toggle("critical", timerSeconds <= 20);

    const pct = Math.min(100, Math.max(0, (elapsedInLevel / lvl.durationSeconds) * 100));
    progressFillEl.style.width = `${pct}%`;

    if (nextLvl) {
      nextSmallEl.textContent = nextLvl.small;
      nextBigEl.textContent = nextLvl.big;
      nextAnteEl.textContent = nextLvl.ante;
      nextAnteWrap.style.display = nextLvl.ante > 0 ? "inline" : "none";
      nextLevelBtn.disabled = false;
    } else {
      nextSmallEl.textContent = "-";
      nextBigEl.textContent = "-";
      nextAnteWrap.style.display = "none";
      nextLevelBtn.disabled = true;
    }
    prevLevelBtn.disabled = idx === 0 && elapsedInLevel < 1;

    const buyinsOpen = effectiveElapsedSeconds() < schedule.lastBuyInSeconds;
    buyinBtn.disabled = !buyinsOpen;
    if (buyinsOpen) {
      buyinStatusText.textContent = "Buy-ins open";
      buyinStatusText.className = "buyin-open";
      const remain = schedule.lastBuyInSeconds - effectiveElapsedSeconds();
      buyinCountdown.textContent = `closes in ${formatHMS(remain)}`;
    } else {
      buyinStatusText.textContent = "Buy-ins closed";
      buyinStatusText.className = "buyin-closed";
      buyinCountdown.textContent = "";
    }

    playersCountEl.textContent = config.players;
    extraBuyinsCountEl.textContent = state.extraBuyins;
    totalPotEl.textContent = `${totalPot()} kr`;

    pauseBtn.textContent = state.pausedAt ? "Resume" : "Pause";

    // Sound cues
    if (lastDisplayedLevel !== null && lastDisplayedLevel !== lvl.level && !state.pausedAt) {
      playPling();
    }
    lastDisplayedLevel = lvl.level;

    if (!buyinsOpen && !buyinsClosedAnnounced && !state.pausedAt) {
      playDong();
      buyinsClosedAnnounced = true;
    }
    if (buyinsOpen) buyinsClosedAnnounced = false;

    if (totalRemaining <= 0) {
      levelLabelEl.textContent = `Tournament complete`;
    }
  }

  function tick() {
    render();
  }

  function startClockLoop() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(tick, 1000);
    render();
  }

  function showScreen(name) {
    if (name === "setup") {
      setupScreen.classList.remove("hidden");
      clockScreen.classList.add("hidden");
    } else {
      setupScreen.classList.add("hidden");
      clockScreen.classList.remove("hidden");
    }
  }

  function startTournament(config) {
    const schedule = generateSchedule(config);
    state = {
      config,
      schedule,
      started: false,
      startTimestamp: null,
      pausedAt: null,
      totalPausedMs: 0,
      manualOffsetSeconds: 0,
      extraBuyins: 0,
    };
    lastDisplayedLevel = null;
    buyinsClosedAnnounced = false;
    saveState(state);
    showScreen("clock");
    startClockLoop();
  }

  function startClock() {
    state.started = true;
    state.startTimestamp = Date.now();
    state.pausedAt = null;
    state.totalPausedMs = 0;
    state.manualOffsetSeconds = 0;
    lastDisplayedLevel = null;
    buyinsClosedAnnounced = false;
    saveState(state);
    render();
  }

  function resumeFromState(saved) {
    state = saved;
    if (state.started) {
      lastDisplayedLevel = state.schedule.levels[currentLevelIndex()].level;
      buyinsClosedAnnounced = effectiveElapsedSeconds() >= state.schedule.lastBuyInSeconds;
    } else {
      lastDisplayedLevel = null;
      buyinsClosedAnnounced = false;
    }
    showScreen("clock");
    startClockLoop();
  }

  function endGame() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
    clearState();
    state = null;
    showScreen("setup");
  }

  /* ---------------------------------------------------------------- */

  setupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    setupError.hidden = true;

    const players = parseInt(document.getElementById("players").value, 10);
    const buyIn = parseInt(document.getElementById("buyin").value, 10);
    const hours = parseInt(document.getElementById("hours").value, 10) || 0;
    const minutes = parseInt(document.getElementById("minutes").value, 10) || 0;
    const levelMinutes = parseInt(document.getElementById("level-minutes").value, 10);
    const lbHours = parseInt(document.getElementById("lastbuyin-hours").value, 10) || 0;
    const lbMinutes = parseInt(document.getElementById("lastbuyin-minutes").value, 10) || 0;

    const totalMinutes = hours * 60 + minutes;
    const lastBuyInMinutes = lbHours * 60 + lbMinutes;

    if (!players || players < 2) {
      setupError.textContent = "Please enter at least 2 players.";
      setupError.hidden = false;
      return;
    }
    if (!buyIn || buyIn < 1) {
      setupError.textContent = "Please enter a valid buy-in amount.";
      setupError.hidden = false;
      return;
    }
    if (totalMinutes < 10) {
      setupError.textContent = "Time of play must be at least 10 minutes.";
      setupError.hidden = false;
      return;
    }
    if (!levelMinutes || levelMinutes < 1) {
      setupError.textContent = "Blind level length must be at least 1 minute.";
      setupError.hidden = false;
      return;
    }
    if (lastBuyInMinutes > totalMinutes) {
      setupError.textContent = "Last possible buy-in can't be after the tournament ends.";
      setupError.hidden = false;
      return;
    }

    startTournament({ players, buyIn, totalMinutes, lastBuyInMinutes, levelMinutes });
  });

  pauseBtn.addEventListener("click", () => {
    if (!state.started) {
      startClock();
    } else {
      setPaused(!state.pausedAt);
    }
  });

  buyinBtn.addEventListener("click", () => {
    const elapsed = state.started ? effectiveElapsedSeconds() : 0;
    if (elapsed >= state.schedule.lastBuyInSeconds) return;
    state.extraBuyins += 1;
    saveState(state);
    render();
  });

  nextLevelBtn.addEventListener("click", () => {
    if (!state.started) return;
    jumpToLevel(currentLevelIndex() + 1);
  });
  prevLevelBtn.addEventListener("click", () => {
    if (!state.started) return;
    const idx = currentLevelIndex();
    const elapsedInLevel = effectiveElapsedSeconds() - idx * state.schedule.levelSeconds;
    if (elapsedInLevel > 3) {
      jumpToLevel(idx);
    } else {
      jumpToLevel(idx - 1);
    }
  });

  newGameBtn.addEventListener("click", () => {
    if (confirm("Start a new game? This will end the current tournament.")) {
      endGame();
    }
  });

  /* ---------------------------------------------------------------- */

  const saved = loadState();
  if (saved && saved.schedule && saved.config) {
    resumeFromState(saved);
  } else {
    showScreen("setup");
  }
})();
