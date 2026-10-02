const api = window.downloadAssistant;
let programs = [];

const loginScreen = document.querySelector("#login-screen");
const appShell = document.querySelector("#app-shell");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const settingsForm = document.querySelector("#settings-form");
const settingsMessage = document.querySelector("#settings-message");

function showToast(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " is-error" : ""}`;
  toast.textContent = message;
  document.querySelector("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function renderPrograms(container) {
  container.replaceChildren();
  for (const program of programs) {
    const card = document.createElement("article");
    card.className = "program-card";
    const header = document.createElement("div");
    header.className = "program-card-head";
    const logo = document.createElement("span");
    logo.className = "program-logo";
    logo.setAttribute("aria-hidden", "true");
    logo.textContent = program.logo;
    const status = document.createElement("span");
    status.className = "program-status";
    status.textContent = program.status;
    header.append(logo, status);

    const kind = document.createElement("span");
    kind.className = "program-kind";
    kind.textContent = program.type === "vst" ? "VST-Plugin" : "Programm";
    const name = document.createElement("h3");
    name.textContent = program.name;
    const description = document.createElement("p");
    description.textContent = program.description;

    const note = document.createElement("p");
    note.className = "program-note";
    note.textContent = program.installationNote;

    const footer = document.createElement("div");
    footer.className = "program-card-footer";
    const version = document.createElement("span");
    version.className = "program-version";
    version.textContent = `Version ${program.version}`;
    const actions = document.createElement("div");
    actions.className = "program-actions";
    for (const [action, label, style] of [
      ["install", "Installieren", "button-primary"],
      ["update", "Update", "button-secondary"],
      ["uninstall", "Deinstallieren", "button-secondary"]
    ]) {
      const button = document.createElement("button");
      button.className = `button ${style}`;
      button.type = "button";
      button.dataset.programAction = action;
      button.dataset.programId = program.id;
      button.disabled = true;
      button.textContent = label;
      actions.append(button);
    }
    footer.append(version, actions);
    card.append(header, kind, name, description, note, footer);
    container.append(card);
  }
}

function showPage(pageName) {
  const pageNames = ["dashboard", "programs", "settings"];
  if (!pageNames.includes(pageName)) {
    return;
  }

  for (const page of pageNames) {
    document.querySelector(`#page-${page}`).classList.toggle("hidden", page !== pageName);
    document.querySelector(`[data-page="${page}"]`)?.classList.toggle("is-active", page === pageName);
  }
  document.querySelector("#breadcrumb-current").textContent =
    pageName === "dashboard" ? "Übersicht" : pageName === "programs" ? "Programme" : "Einstellungen";
}

async function populateSettings() {
  const settings = await api.loadSettings();
  document.querySelector("#download-directory").value = settings.downloadDirectory;
  document.querySelector("#automatic-updates").checked = settings.automaticUpdates;
}

const SESSION_KEY = "jsStudioSession";

function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY));
    return session && typeof session.username === "string" && session.username.trim()
      ? session
      : null;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage nicht verfügbar; nichts zu löschen.
  }
}

async function enterDashboard(username) {
  {
    programs = await api.listPrograms();
    await populateSettings();
    document.querySelector("#core-version").textContent =
      `App-Core ${await api.getCoreVersion()}`;

    document.querySelector("#profile-name").textContent = username;
    document.querySelector("#profile-initials").textContent =
      username.trim().slice(0, 2).toUpperCase() || "JS";
    loginScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
    renderPrograms(document.querySelector("#featured-programs"));
    renderPrograms(document.querySelector("#program-catalog"));
    document.querySelector("#program-count").textContent = String(programs.length).padStart(2, "0");
    document.querySelector("#installed-count").textContent =
      String(programs.filter((program) => program.status === "Installiert").length).padStart(2, "0");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const formData = new FormData(loginForm);
  const submitButton = loginForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");
    if (!username || !password) {
      loginError.textContent = "Bitte geben Sie einen Benutzernamen und ein Passwort ein.";
      return;
    }

    await enterDashboard(username);
    if (formData.get("remember")) {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ username }));
      } catch {
        showToast("Anmeldung konnte nicht gespeichert werden.", true);
      }
    } else {
      clearSession();
    }
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", () => {
  clearSession();
  appShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginForm.reset();
  loginError.textContent = "";
});

document.querySelector("#window-minimize").addEventListener("click", async () => {
  try {
    await api.windowControls.minimize();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector("#window-maximize").addEventListener("click", async (event) => {
  try {
    const isMaximized = await api.windowControls.toggleMaximize();
    event.currentTarget.textContent = isMaximized ? "❐" : "□";
    event.currentTarget.title = isMaximized ? "Wiederherstellen" : "Maximieren";
    event.currentTarget.setAttribute("aria-label", event.currentTarget.title);
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector("#window-close").addEventListener("click", async () => {
  try {
    await api.windowControls.close();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-program-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.programAction;
  const methods = {
    install: api.installProgram,
    update: api.updateProgram,
    uninstall: api.uninstallProgram
  };
  const method = methods[action];
  button.disabled = true;
  try {
    await method(button.dataset.programId);
    showToast(action === "uninstall" ? "Deinstallation abgeschlossen." : "Vorgang abgeschlossen.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsMessage.textContent = "";
  try {
    await api.saveSettings({
      downloadDirectory: document.querySelector("#download-directory").value,
      automaticUpdates: document.querySelector("#automatic-updates").checked
    });
    settingsMessage.textContent = "Einstellungen gespeichert.";
  } catch (error) {
    settingsMessage.textContent = error.message;
  }
});

document.querySelector("#choose-directory").addEventListener("click", async () => {
  try {
    const directory = await api.chooseDownloadDirectory();
    if (directory) {
      document.querySelector("#download-directory").value = directory;
    }
  } catch (error) {
    settingsMessage.textContent = error.message;
  }
});

document.querySelector("#check-updates").addEventListener("click", async () => {
  try {
    const result = await api.checkForUpdates();
    if (result.updateAvailable) {
      showToast(`Core-Version ${result.version} ist verfügbar. Aktivieren Sie automatische Updates in den Einstellungen.`, true);
    } else if (!result.updated) {
      showToast(`Der App-Core ${result.version} ist aktuell.`);
    }
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector("#uninstall-assistant").addEventListener("click", async () => {
  if (!window.confirm("Möchten Sie den JS Studio Download-Assistenten wirklich deinstallieren?")) {
    return;
  }
  try {
    await api.uninstallAssistant();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector("#update-install").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api.checkForUpdates();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
});

if (api) {
  api.onUpdateStatus((status) => {
    if (status?.updateAvailable) {
      document.querySelector("#update-banner").classList.remove("hidden");
    } else if (status?.message) {
      showToast(status.message, status.type === "error");
    }
  });

  api.onReleaseNotes((releaseNotes) => {
    const content = document.querySelector("#release-notes-content");
    content.replaceChildren();
    const heading = document.createElement("p");
    heading.textContent = `App-Core ${releaseNotes.version} wurde installiert.`;
    const list = document.createElement("ul");
    for (const note of releaseNotes.notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.append(item);
    }
    content.append(heading, list);
    document.querySelector("#release-notes-dialog").showModal();
  });

  const savedSession = readSession();
  if (savedSession) {
    document.querySelector("#username").value = savedSession.username;
    document.querySelector("#remember-me").checked = true;
    enterDashboard(savedSession.username).catch((error) => {
      loginError.textContent = error.message;
    });
  }
} else {
  loginError.textContent = "Bitte starten Sie den Download-Assistenten über die Desktop-App.";
  loginForm.querySelector('[type="submit"]').disabled = true;
}
