"use strict";

var { MigrationUtils } = ChromeUtils.importESModule(
  "resource:///modules/MigrationUtils.sys.mjs"
);
var { LoginHelper } = ChromeUtils.import(
  "resource://gre/modules/LoginHelper.jsm"
);
var { NetUtil } = ChromeUtils.import("resource://gre/modules/NetUtil.jsm");
var { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
var { Preferences } = ChromeUtils.importESModule(
  "resource://gre/modules/Preferences.sys.mjs"
);
var { PromiseUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PromiseUtils.sys.mjs"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

// Initialize profile.
var gProfD = do_get_profile();

var { getAppInfo, newAppInfo, updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo();

/**
 * Migrates the requested resource and waits for the migration to be complete.
 *
 * @param {MigratorBase} migrator
 *   The migrator being used to migrate the data.
 * @param {number} resourceType
 *   This is a bitfield with bits from nsIBrowserProfileMigrator flipped to indicate what
 *   resources should be migrated.
 * @param {object|string|null} [aProfile=null]
 *   The profile to be migrated. If set to null, the default profile will be
 *   migrated.
 * @param {boolean} succeeds
 *   True if this migration is expected to succeed.
 * @returns {Promise<Array<string[]>>}
 *   An array of the results from each nsIObserver topics being observed to
 *   verify if the migration succeeded or failed. Those results are 2-element
 *   arrays of [subject, data].
 */
async function promiseMigration(
  migrator,
  resourceType,
  aProfile = null,
  succeeds = null
) {
  // Ensure resource migration is available.
  let availableSources = await migrator.getMigrateData(aProfile);
  Assert.ok(
    (availableSources & resourceType) > 0,
    "Resource supported by migrator"
  );
  let promises = [TestUtils.topicObserved("Migration:Ended")];

  if (succeeds !== null) {
    // Check that the specific resource type succeeded
    promises.push(
      TestUtils.topicObserved(
        succeeds ? "Migration:ItemAfterMigrate" : "Migration:ItemError",
        (_, data) => data == resourceType
      )
    );
  }

  // Start the migration.
  migrator.migrate(resourceType, null, aProfile);

  return Promise.all(promises);
}
/**
 * Function that returns a favicon url for a given page url
 *
 * @param {string} uri
 * The Bookmark URI
 * @returns {string} faviconURI
 * The Favicon URI
 */
async function getFaviconForPageURI(uri) {
  let faviconURI = await new Promise(resolve => {
    PlacesUtils.favicons.getFaviconDataForPage(uri, favURI => {
      resolve(favURI);
    });
  });
  return faviconURI;
}

/**
 * Takes an array of page URIs and checks that the favicon was imported for each page URI
 *
 * @param {Array} pageURIs An array of page URIs
 */
async function assertFavicons(pageURIs) {
  for (let uri of pageURIs) {
    let faviconURI = await getFaviconForPageURI(uri);
    Assert.ok(faviconURI, `Got favicon for ${uri.spec}`);
  }
}

/**
 * Replaces a directory service entry with a given nsIFile.
 *
 * @param {string} key
 *   The nsIDirectoryService directory key to register a fake path for.
 *   For example: "AppData", "ULibDir".
 * @param {nsIFile} file
 *   The nsIFile to map the key to. Note that this nsIFile should represent
 *   a directory and not an individual file.
 * @see nsDirectoryServiceDefs.h for the list of directories that can be
 *   overridden.
 */
function registerFakePath(key, file) {
  let dirsvc = Services.dirsvc.QueryInterface(Ci.nsIProperties);
  let originalFile;
  try {
    // If a file is already provided save it and undefine, otherwise set will
    // throw for persistent entries (ones that are cached).
    originalFile = dirsvc.get(key, Ci.nsIFile);
    dirsvc.undefine(key);
  } catch (e) {
    // dirsvc.get will throw if nothing provides for the key and dirsvc.undefine
    // will throw if it's not a persistent entry, in either case we don't want
    // to set the original file in cleanup.
    originalFile = undefined;
  }

  dirsvc.set(key, file);
  registerCleanupFunction(() => {
    dirsvc.undefine(key);
    if (originalFile) {
      dirsvc.set(key, originalFile);
    }
  });
}

function getRootPath() {
  let dirKey;
  if (AppConstants.platform == "win") {
    dirKey = "LocalAppData";
  } else if (AppConstants.platform == "macosx") {
    dirKey = "ULibDir";
  } else {
    dirKey = "Home";
  }
  return Services.dirsvc.get(dirKey, Ci.nsIFile).path;
}

/**
 * Returns a PRTime value for the current date minus daysAgo number
 * of days.
 *
 * @param {number} daysAgo
 *   How many days in the past from now the returned date should be.
 * @returns {number}
 */
function PRTimeDaysAgo(daysAgo) {
  return PlacesUtils.toPRTime(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

/**
 * Returns a Date value for the current date minus daysAgo number
 * of days.
 *
 * @param {number} daysAgo
 *   How many days in the past from now the returned date should be.
 * @returns {Date}
 */
function dateDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}
