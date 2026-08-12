(() => {
const {
  CHANNEL_NAME,
  WarpRenderer,
  persistState,
  readState,
} = window.NioWarp;

const channel = new BroadcastChannel(CHANNEL_NAME);
let state = readState();

function sendState() {
  persistState(state);
  channel.postMessage({ type: "state", state });
}

function setupControlPage() {
  const physicalRenderer = new WarpRenderer(document.querySelector("#physical-preview"), state);
  const correctedRenderer = new WarpRenderer(document.querySelector("#corrected-preview"), state);
  const previewRender = () => {
    physicalRenderer.setState({ ...state, mode: "physical" });
    correctedRenderer.setState({ ...state, mode: "corrected" });
  };

  const inputs = [...document.querySelectorAll("[data-state]")];
  inputs.forEach((input) => {
    const key = input.dataset.state;
    if (input.type === "checkbox") input.checked = Boolean(state[key]);
    else input.value = state[key];
    const valueLabel = document.querySelector(`[data-value-for="${key}"]`);
    if (valueLabel) valueLabel.textContent = input.value;

    input.addEventListener("input", () => {
      state = {
        ...state,
        [key]: input.type === "checkbox" ? input.checked : Number(input.value),
      };
      if (valueLabel) valueLabel.textContent = input.value;
      previewRender();
      sendState();
    });
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state = { ...state, mode: button.dataset.mode };
      document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
      sendState();
    });
  });

  document.querySelector(`[data-mode="${state.mode}"]`)?.classList.add("active");
  document.querySelector("#open-output").addEventListener("click", () => {
    const outputWindow = window.open("output.html", "nio-warp-output", "popup=yes,width=1600,height=900");
    outputWindow?.focus();
  });
  document.querySelector("#reset-state").addEventListener("click", () => {
    localStorage.removeItem(window.NioWarp.STORAGE_KEY);
    window.location.reload();
  });
  document.querySelector("#image-input").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state = { ...state, uploadedImage: reader.result };
      previewRender();
      channel.postMessage({ type: "state", state });
    };
    reader.readAsDataURL(file);
  });

  channel.addEventListener("message", (event) => {
    if (event.data?.type === "request-state") sendState();
  });
  previewRender();
}

function setupOutputPage() {
  const renderer = new WarpRenderer(document.querySelector("#output-canvas"), state);
  const modeLabel = document.querySelector("#output-mode");
  const canvasLabel = document.querySelector("#output-canvas-height");

  const refresh = () => {
    renderer.setState(state);
    modeLabel.textContent = {
      physical: "物理屏预畸变输出",
      corrected: "模拟反射后校正结果",
      uncorrected: "模拟反射未校正",
      source: "扩展虚拟画布",
    }[state.mode] || state.mode;
    canvasLabel.textContent = `${state.canvasHeight}px`;
  };

  const setMode = (mode) => {
    state = { ...state, mode };
    sendState();
    refresh();
  };

  channel.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      state = { ...state, ...event.data.state };
      refresh();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === window.NioWarp.STORAGE_KEY) {
      state = readState();
      refresh();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "1") setMode("source");
    if (event.key === "2") setMode("uncorrected");
    if (event.key === "3") setMode("physical");
    if (event.key === "4") setMode("corrected");
    if (event.key.toLowerCase() === "f") {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    }
    if (event.key.toLowerCase() === "h") document.body.classList.toggle("hide-hud");
  });
  document.querySelector("#fullscreen-output").addEventListener("click", () => document.documentElement.requestFullscreen());
  channel.postMessage({ type: "request-state" });
  refresh();
}

if (document.body.dataset.page === "control") setupControlPage();
if (document.body.dataset.page === "output") setupOutputPage();
})();
