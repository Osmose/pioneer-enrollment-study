const { utils: Cu } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "studyUtils",
  "resource://pioneer-enrollment-study/StudyUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "config",
  "resource://pioneer-enrollment-study/Config.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow",
  "resource:///modules/RecentWindow.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "AboutPages",
  "resource://pioneer-enrollment-study-content/AboutPages.jsm");

const REASONS = {
  APP_STARTUP:      1, // The application is starting up.
  APP_SHUTDOWN:     2, // The application is shutting down.
  ADDON_ENABLE:     3, // The add-on is being enabled.
  ADDON_DISABLE:    4, // The add-on is being disabled. (Also sent during uninstallation)
  ADDON_INSTALL:    5, // The add-on is being installed.
  ADDON_UNINSTALL:  6, // The add-on is being uninstalled.
  ADDON_UPGRADE:    7, // The add-on is being upgraded.
  ADDON_DOWNGRADE:  8, // The add-on is being downgraded.
};
const TREATMENT_OVERRIDE_PREF = "extensions.pioneer-enrollment-study.treatment";
const EXPIRATION_DATE_STRING_PREF = "extensions.pioneer-enrollment-study.expirationDateString";

// Due to bug 1051238 frame scripts are cached forever, so we can't update them
// as a restartless add-on. The Math.random() is the work around for this.
const PROCESS_SCRIPT = (
  `resource://pioneer-enrollment-study-content/process-script.js?${Math.random()}`
);
const FRAME_SCRIPT = (
  `resource://pioneer-enrollment-study-content/frame-script.js?${Math.random()}`
);

const TREATMENTS = {
  control() {

  },
  popunder() {
    const mostRecentWindow = RecentWindow.getMostRecentBrowserWindow({
      private: false,
      allowPopups: false,
    });
    if (mostRecentWindow && mostRecentWindow.gBrowser) {
      mostRecentWindow.gBrowser.loadOneTab("about:pioneer", {
        inBackground: true,
      });
    }
  },
};

async function chooseVariation() {
  let variation;
  // if pref has a user-set value, use this instead
  if (Services.prefs.prefHasUserValue(TREATMENT_OVERRIDE_PREF)) {
    variation = {
      name: Services.prefs.getCharPref(TREATMENT_OVERRIDE_PREF, null), // there is no default value
      weight: 1,
    };
    if (variation.name in TREATMENTS) { return variation; }
    // if the variation from the pref is invalid, then fall back to standard choosing
  }

  const sample = studyUtils.sample;
  // this is the standard arm choosing method
  const clientId = await studyUtils.getTelemetryId();
  const hashFraction = await sample.hashFraction(config.study.studyName + clientId);
  variation = sample.chooseWeighted(config.study.weightedVariations, hashFraction);

  // if the variation chosen by chooseWeighted is not a valid treatment (check in TREATMENTS),
  // then throw an exception: this means that the config file is wrong
  if (!(variation.name in TREATMENTS)) {
    throw new Error(`The variation "${variation.name}" is not a valid variation.`);
  }

  return variation;
}

this.install = function() {};

this.startup = async function(data, reason) {
  studyUtils.setup({
    ...config,
    addon: { id: data.id, version: data.version },
  });
  const variation = await chooseVariation();
  studyUtils.setVariation(variation);

  // Always set EXPIRATION_DATE_PREF if it not set, even if outside of install.
  // This is a failsafe if opt-out expiration doesn't work, so should be resilient.
  // Also helps for testing.
  if (!Services.prefs.prefHasUserValue(EXPIRATION_DATE_STRING_PREF)) {
    const now = new Date(Date.now());
    const expirationDateString = new Date(now.setDate(now.getDate() + 14)).toISOString();
    Services.prefs.setCharPref(EXPIRATION_DATE_STRING_PREF, expirationDateString);
  }

  if (reason === REASONS.ADDON_INSTALL) {
    studyUtils.firstSeen(); // sends telemetry "enter"
    const eligible = await config.isEligible(); // addon-specific
    if (!eligible) {
      // uses config.endings.ineligible.url if any,
      // sends UT for "ineligible"
      // then uninstalls addon
      await studyUtils.endStudy({ reason: "ineligible" });
      return;
    }
  }
  // sets experiment as active and sends installed telemetry upon first install
  await studyUtils.startup({ reason });

  const expirationDate = new Date(Services.prefs.getCharPref(EXPIRATION_DATE_STRING_PREF));
  if (Date.now() > expirationDate) {
    studyUtils.endStudy({ reason: "expired" });
  }

  // Load scripts in content processes and tabs
  Services.ppmm.loadProcessScript(PROCESS_SCRIPT, true);
  Services.mm.loadFrameScript(FRAME_SCRIPT, true);

  // Register about: pages and their listeners
  AboutPages.aboutPioneer.register();
  AboutPages.aboutPioneer.registerParentListeners();

  // Run treatment
  TREATMENTS[variation.name]();
};

this.shutdown = async function(data, reason) {
  // Stop loading processs scripts and notify existing scripts to clean up.
  Services.ppmm.removeDelayedProcessScript(PROCESS_SCRIPT);
  Services.ppmm.broadcastAsyncMessage("Pioneer:ShuttingDown");
  Services.mm.removeDelayedFrameScript(FRAME_SCRIPT);
  Services.mm.broadcastAsyncMessage("Pioneer:ShuttingDown");

  // Clean up about pages
  AboutPages.aboutPioneer.unregisterParentListeners();
  AboutPages.aboutPioneer.unregister();

  Cu.unload("resource://pioneer-enrollment-study/StudyUtils.jsm");
  Cu.unload("resource://pioneer-enrollment-study/Config.jsm");
  Cu.unload("resource://pioneer-enrollment-study-content/AboutPages.jsm");

  // are we uninstalling?
  // if so, user or automatic?
  if (reason === REASONS.ADDON_UNINSTALL || reason === REASONS.ADDON_DISABLE) {
    if (!studyUtils._isEnding) {
      // we are the first requestors, must be user action.
      studyUtils.endStudy({ reason: "user-disable" });
    }
  }
};

this.uninstall = function() {};
