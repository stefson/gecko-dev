/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  NetworkHelper:
    "resource://devtools/shared/network-observer/NetworkHelper.sys.mjs",
});

XPCOMUtils.defineLazyGetter(lazy, "tpFlagsMask", () => {
  const trackingProtectionLevel2Enabled = Services.prefs
    .getStringPref("urlclassifier.trackingTable")
    .includes("content-track-digest256");

  return trackingProtectionLevel2Enabled
    ? ~Ci.nsIClassifiedChannel.CLASSIFIED_ANY_BASIC_TRACKING &
        ~Ci.nsIClassifiedChannel.CLASSIFIED_ANY_STRICT_TRACKING
    : ~Ci.nsIClassifiedChannel.CLASSIFIED_ANY_BASIC_TRACKING &
        Ci.nsIClassifiedChannel.CLASSIFIED_ANY_STRICT_TRACKING;
});

/**
 * Convert a nsIContentPolicy constant to a display string
 */
const LOAD_CAUSE_STRINGS = {
  [Ci.nsIContentPolicy.TYPE_INVALID]: "invalid",
  [Ci.nsIContentPolicy.TYPE_OTHER]: "other",
  [Ci.nsIContentPolicy.TYPE_SCRIPT]: "script",
  [Ci.nsIContentPolicy.TYPE_IMAGE]: "img",
  [Ci.nsIContentPolicy.TYPE_STYLESHEET]: "stylesheet",
  [Ci.nsIContentPolicy.TYPE_OBJECT]: "object",
  [Ci.nsIContentPolicy.TYPE_DOCUMENT]: "document",
  [Ci.nsIContentPolicy.TYPE_SUBDOCUMENT]: "subdocument",
  [Ci.nsIContentPolicy.TYPE_PING]: "ping",
  [Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST]: "xhr",
  [Ci.nsIContentPolicy.TYPE_OBJECT_SUBREQUEST]: "objectSubdoc",
  [Ci.nsIContentPolicy.TYPE_DTD]: "dtd",
  [Ci.nsIContentPolicy.TYPE_FONT]: "font",
  [Ci.nsIContentPolicy.TYPE_MEDIA]: "media",
  [Ci.nsIContentPolicy.TYPE_WEBSOCKET]: "websocket",
  [Ci.nsIContentPolicy.TYPE_CSP_REPORT]: "csp",
  [Ci.nsIContentPolicy.TYPE_XSLT]: "xslt",
  [Ci.nsIContentPolicy.TYPE_BEACON]: "beacon",
  [Ci.nsIContentPolicy.TYPE_FETCH]: "fetch",
  [Ci.nsIContentPolicy.TYPE_IMAGESET]: "imageset",
  [Ci.nsIContentPolicy.TYPE_WEB_MANIFEST]: "webManifest",
  [Ci.nsIContentPolicy.TYPE_WEB_IDENTITY]: "webidentity",
};

function causeTypeToString(causeType, loadFlags, internalContentPolicyType) {
  let prefix = "";
  if (
    (causeType == Ci.nsIContentPolicy.TYPE_IMAGESET ||
      internalContentPolicyType == Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE) &&
    loadFlags & Ci.nsIRequest.LOAD_BACKGROUND
  ) {
    prefix = "lazy-";
  }

  return prefix + LOAD_CAUSE_STRINGS[causeType] || "unknown";
}

function stringToCauseType(value) {
  return Object.keys(LOAD_CAUSE_STRINGS).find(
    key => LOAD_CAUSE_STRINGS[key] === value
  );
}

function isChannelFromSystemPrincipal(channel) {
  let principal = null;
  let browsingContext = channel.loadInfo.browsingContext;
  if (!browsingContext) {
    const topFrame = lazy.NetworkHelper.getTopFrameForRequest(channel);
    if (topFrame) {
      browsingContext = topFrame.browsingContext;
    } else {
      // Fallback to the triggering principal when browsingContext and topFrame is null
      // e.g some chrome requests
      principal = channel.loadInfo.triggeringPrincipal;
    }
  }

  // When in the parent process, we can get the documentPrincipal from the
  // WindowGlobal which is available on the BrowsingContext
  if (!principal) {
    principal = CanonicalBrowsingContext.isInstance(browsingContext)
      ? browsingContext.currentWindowGlobal.documentPrincipal
      : browsingContext.window.document.nodePrincipal;
  }
  return principal.isSystemPrincipal;
}

/**
 * Get the browsing context id for the channel.
 *
 * @param {*} channel
 * @returns {number}
 */
function getChannelBrowsingContextID(channel) {
  if (channel.loadInfo.browsingContextID) {
    return channel.loadInfo.browsingContextID;
  }
  // At least WebSocket channel aren't having a browsingContextID set on their loadInfo
  // We fallback on top frame element, which works, but will be wrong for WebSocket
  // in same-process iframes...
  const topFrame = lazy.NetworkHelper.getTopFrameForRequest(channel);
  // topFrame is typically null for some chrome requests like favicons
  if (topFrame && topFrame.browsingContext) {
    return topFrame.browsingContext.id;
  }
  return null;
}

/**
 * Get the innerWindowId for the channel.
 *
 * @param {*} channel
 * @returns {number}
 */
function getChannelInnerWindowId(channel) {
  if (channel.loadInfo.innerWindowID) {
    return channel.loadInfo.innerWindowID;
  }
  // At least WebSocket channel aren't having a browsingContextID set on their loadInfo
  // We fallback on top frame element, which works, but will be wrong for WebSocket
  // in same-process iframes...
  const topFrame = lazy.NetworkHelper.getTopFrameForRequest(channel);
  // topFrame is typically null for some chrome requests like favicons
  if (topFrame?.browsingContext?.currentWindowGlobal) {
    return topFrame.browsingContext.currentWindowGlobal.innerWindowId;
  }
  return null;
}

/**
 * Does this channel represent a Preload request.
 *
 * @param {*} channel
 * @returns {boolean}
 */
function isPreloadRequest(channel) {
  const type = channel.loadInfo.internalContentPolicyType;
  return (
    type == Ci.nsIContentPolicy.TYPE_INTERNAL_SCRIPT_PRELOAD ||
    type == Ci.nsIContentPolicy.TYPE_INTERNAL_MODULE_PRELOAD ||
    type == Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_PRELOAD ||
    type == Ci.nsIContentPolicy.TYPE_INTERNAL_STYLESHEET_PRELOAD ||
    type == Ci.nsIContentPolicy.TYPE_INTERNAL_FONT_PRELOAD
  );
}

/**
 * Get the channel cause details.
 *
 * @param {nsIChannel} channel
 * @returns {Object}
 *          - loadingDocumentUri {string} uri of the document which created the
 *            channel
 *          - type {string} cause type as string
 */
function getCauseDetails(channel) {
  // Determine the cause and if this is an XHR request.
  let causeType = Ci.nsIContentPolicy.TYPE_OTHER;
  let causeUri = null;

  if (channel.loadInfo) {
    causeType = channel.loadInfo.externalContentPolicyType;
    const { loadingPrincipal } = channel.loadInfo;
    if (loadingPrincipal) {
      causeUri = loadingPrincipal.spec;
    }
  }

  return {
    loadingDocumentUri: causeUri,
    type: causeTypeToString(
      causeType,
      channel.loadFlags,
      channel.loadInfo.internalContentPolicyType
    ),
  };
}

/**
 * Get the channel priority. Priority is a number which typically ranges from
 * -20 (lowest priority) to 20 (highest priority). Can be null if the channel
 * does not implement nsISupportsPriority.
 *
 * @param {nsIChannel} channel
 * @returns {number|undefined}
 */
function getChannelPriority(channel) {
  if (channel instanceof Ci.nsISupportsPriority) {
    return channel.priority;
  }

  return null;
}

/**
 * Get the channel HTTP version as an uppercase string starting with "HTTP/"
 * (eg "HTTP/2.0").
 *
 * @param {nsIChannel} channel
 * @returns {string}
 */
function getHttpVersion(channel) {
  // Determine the HTTP version.
  const httpVersionMaj = {};
  const httpVersionMin = {};

  channel.QueryInterface(Ci.nsIHttpChannelInternal);
  channel.getRequestVersion(httpVersionMaj, httpVersionMin);

  return "HTTP/" + httpVersionMaj.value + "." + httpVersionMin.value;
}

/**
 * Get the channel referrer policy as a string
 * (eg "strict-origin-when-cross-origin").
 *
 * @param {nsIChannel} channel
 * @returns {string}
 */
function getReferrerPolicy(channel) {
  return channel.referrerInfo
    ? channel.referrerInfo.getReferrerPolicyString()
    : "";
}

/**
 * Check if the channel is private.
 *
 * @param {nsIChannel} channel
 * @returns {boolean}
 */
function isChannelPrivate(channel) {
  channel.QueryInterface(Ci.nsIPrivateBrowsingChannel);
  return channel.isChannelPrivate;
}

/**
 * isNavigationRequest is true for the one request used to load a new top level
 * document of a given tab, or top level window. It will typically be false for
 * navigation requests of iframes, i.e. the request loading another document in
 * an iframe.
 *
 * @param {nsIChannel} channel
 * @return {boolean}
 */
function isNavigationRequest(channel) {
  return channel.isMainDocumentChannel && channel.loadInfo.isTopLevelLoad;
}

/**
 * Returns true  if the channel has been processed by URL-Classifier features
 * and is considered third-party with the top window URI, and if it has loaded
 * a resource that is classified as a tracker.
 *
 * @param {nsIChannel} channel
 * @return {boolean}
 */
function isThirdPartyTrackingResource(channel) {
  // Only consider channels classified as level-1 to be trackers if our preferences
  // would not cause such channels to be blocked in strict content blocking mode.
  // Make sure the value produced here is a boolean.
  return !!(
    channel instanceof Ci.nsIClassifiedChannel &&
    channel.isThirdPartyTrackingResource() &&
    (channel.thirdPartyClassificationFlags & lazy.tpFlagsMask) == 0
  );
}

/**
 * Retrieve the websocket channel for the provided channel, if available.
 * Returns null otherwise.
 *
 * @param {nsIChannel} channel
 * @returns {nsIWebSocketChannel|null}
 */
function getWebSocketChannel(channel) {
  let wsChannel = null;
  if (channel.notificationCallbacks) {
    try {
      wsChannel = channel.notificationCallbacks.QueryInterface(
        Ci.nsIWebSocketChannel
      );
    } catch (e) {
      // Not all channels implement nsIWebSocketChannel.
    }
  }
  return wsChannel;
}

/**
 * For a given channel, with its associated http activity object,
 * fetch the request's headers and cookies.
 * This data is passed to the owner, i.e. the NetworkEventActor,
 * so that the frontend can later fetch it via getRequestHeaders/getRequestCookies.
 *
 * @param {nsIChannel} channel
 * @return {Object}
 *     An object with two properties:
 *     @property {Array<Object>} cookies
 *         Array of { name, value } objects.
 *     @property {Array<Object>} headers
 *         Array of { name, value } objects.
 */
function fetchRequestHeadersAndCookies(channel) {
  const headers = [];
  let cookies = [];
  let cookieHeader = null;

  // Copy the request header data.
  channel.visitRequestHeaders({
    visitHeader(name, value) {
      if (name == "Cookie") {
        cookieHeader = value;
      }
      headers.push({ name, value });
    },
  });

  if (cookieHeader) {
    cookies = lazy.NetworkHelper.parseCookieHeader(cookieHeader);
  }

  return { cookies, headers };
}

/**
 * Check if a given network request should be logged by a network monitor
 * based on the specified filters.
 *
 * @param nsIHttpChannel channel
 *        Request to check.
 * @param filters
 *        NetworkObserver filters to match against. An object with one of the following attributes:
 *        - sessionContext: When inspecting requests from the parent process, pass the WatcherActor's session context.
 *          This helps know what is the overall debugged scope.
 *          See watcher actor constructor for more info.
 *        - targetActor: When inspecting requests from the content process, pass the WindowGlobalTargetActor.
 *          This helps know what exact subset of request we should accept.
 *          This is especially useful to behave correctly regarding EFT, where we should include or not
 *          iframes requests.
 *        - browserId, addonId, window: All these attributes are legacy.
 *          Only browserId attribute is still used by the legacy WebConsoleActor startListener API.
 * @return boolean
 *         True if the network request should be logged, false otherwise.
 */
function matchRequest(channel, filters) {
  // NetworkEventWatcher should now pass a session context for the parent process codepath
  if (filters.sessionContext) {
    const { type } = filters.sessionContext;
    if (type == "all") {
      return true;
    }

    // Ignore requests from chrome or add-on code when we don't monitor the whole browser
    if (
      channel.loadInfo?.loadingDocument === null &&
      (channel.loadInfo.loadingPrincipal ===
        Services.scriptSecurityManager.getSystemPrincipal() ||
        channel.loadInfo.isInDevToolsContext)
    ) {
      return false;
    }

    if (type == "browser-element") {
      if (!channel.loadInfo.browsingContext) {
        const topFrame = lazy.NetworkHelper.getTopFrameForRequest(channel);
        // `topFrame` is typically null for some chrome requests like favicons
        // And its `browsingContext` attribute might be null if the request happened
        // while the tab is being closed.
        return (
          topFrame?.browsingContext?.browserId ==
          filters.sessionContext.browserId
        );
      }
      return (
        channel.loadInfo.browsingContext.browserId ==
        filters.sessionContext.browserId
      );
    }
    if (type == "webextension") {
      return (
        channel.loadInfo?.loadingPrincipal?.addonId ===
        filters.sessionContext.addonId
      );
    }
    throw new Error("Unsupported session context type: " + type);
  }

  // NetworkEventContentWatcher and NetworkEventStackTraces pass a target actor instead, from the content processes
  // Because of EFT, we can't use session context as we have to know what exact windows the target actor covers.
  if (filters.targetActor) {
    // Bug 1769982 the target actor might be destroying and accessing windows will throw.
    // Ignore all further request when this happens.
    let windows;
    try {
      windows = filters.targetActor.windows;
    } catch (e) {
      return false;
    }
    const win = lazy.NetworkHelper.getWindowForRequest(channel);
    return windows.includes(win);
  }

  // This is fallback code for the legacy WebConsole.startListeners codepath,
  // which may still pass individual browserId/window/addonId attributes.
  // This should be removable once we drop the WebConsole codepath for network events
  // (bug 1721592 and followups)
  return legacyMatchRequest(channel, filters);
}

function legacyMatchRequest(channel, filters) {
  // Log everything if no filter is specified
  if (!filters.browserId && !filters.window && !filters.addonId) {
    return true;
  }

  // Ignore requests from chrome or add-on code when we are monitoring
  // content.
  if (
    channel.loadInfo?.loadingDocument === null &&
    (channel.loadInfo.loadingPrincipal ===
      Services.scriptSecurityManager.getSystemPrincipal() ||
      channel.loadInfo.isInDevToolsContext)
  ) {
    return false;
  }

  if (filters.window) {
    let win = lazy.NetworkHelper.getWindowForRequest(channel);
    if (filters.matchExactWindow) {
      return win == filters.window;
    }

    // Since frames support, this.window may not be the top level content
    // frame, so that we can't only compare with win.top.
    while (win) {
      if (win == filters.window) {
        return true;
      }
      if (win.parent == win) {
        break;
      }
      win = win.parent;
    }
    return false;
  }

  if (filters.browserId) {
    const topFrame = lazy.NetworkHelper.getTopFrameForRequest(channel);
    // `topFrame` is typically null for some chrome requests like favicons
    // And its `browsingContext` attribute might be null if the request happened
    // while the tab is being closed.
    if (topFrame?.browsingContext?.browserId == filters.browserId) {
      return true;
    }

    // If we couldn't get the top frame BrowsingContext from the loadContext,
    // look for it on channel.loadInfo instead.
    if (channel.loadInfo?.browsingContext?.browserId == filters.browserId) {
      return true;
    }
  }

  if (
    filters.addonId &&
    channel.loadInfo?.loadingPrincipal?.addonId === filters.addonId
  ) {
    return true;
  }

  return false;
}

function getBlockedReason(channel) {
  let blockingExtension, blockedReason;
  const { status } = channel;

  try {
    const request = channel.QueryInterface(Ci.nsIHttpChannel);
    const properties = request.QueryInterface(Ci.nsIPropertyBag);

    blockedReason = request.loadInfo.requestBlockingReason;
    blockingExtension = properties.getProperty("cancelledByExtension");

    // WebExtensionPolicy is not available for workers
    if (typeof WebExtensionPolicy !== "undefined") {
      blockingExtension = WebExtensionPolicy.getByID(blockingExtension).name;
    }
  } catch (err) {
    // "cancelledByExtension" doesn't have to be available.
  }
  // These are platform errors which are not exposed to the users,
  // usually the requests (with these errors) might be displayed with various
  // other status codes.
  const ignoreList = [
    // This is emited when the request is already in the cache.
    "NS_ERROR_PARSED_DATA_CACHED",
    // This is emited when there is some issues around images e.g When the img.src
    // links to a non existent url. This is typically shown as a 404 request.
    "NS_IMAGELIB_ERROR_FAILURE",
    // This is emited when there is a redirect. They are shown as 301 requests.
    "NS_BINDING_REDIRECTED",
    // E.g Emited by send beacon requests.
    "NS_ERROR_ABORT",
  ];

  // If the request has not failed or is not blocked by a web extension, check for
  // any errors not on the ignore list. e.g When a host is not found (NS_ERROR_UNKNOWN_HOST).
  if (
    blockedReason == 0 &&
    !Components.isSuccessCode(status) &&
    !ignoreList.includes(ChromeUtils.getXPCOMErrorName(status))
  ) {
    blockedReason = ChromeUtils.getXPCOMErrorName(status);
  }

  return { blockingExtension, blockedReason };
}

export const NetworkUtils = {
  causeTypeToString,
  fetchRequestHeadersAndCookies,
  getCauseDetails,
  getChannelBrowsingContextID,
  getChannelInnerWindowId,
  getChannelPriority,
  getHttpVersion,
  getReferrerPolicy,
  getWebSocketChannel,
  isChannelFromSystemPrincipal,
  isChannelPrivate,
  isNavigationRequest,
  isPreloadRequest,
  isThirdPartyTrackingResource,
  matchRequest,
  stringToCauseType,
  getBlockedReason,
};
