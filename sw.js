/*
  Cabo Cooks offline copy.

  The browser keeps the files listed below in a cache named cabo-cooks-v1.
  A newer copy of this file should use a new name. On activate, any cache
  that is not the current name is deleted, so an old copy does not linger.

  Opening the app, or loading data/recipes.json, tries the network first.
  A new recipe in that file shows up while the phone is online. If the
  network fails, the saved copy is used, so a reload still opens the book.

  CSS, JavaScript, the manifest, and the icons are taken from the cache
  first. They change only when this file's cache name changes.

  The address after the # sign (#recipe/5, #list, #cook/5/2, #new,
  #edit/5) is handled by app.js. This file never sees that part, and it
  does not read or write localStorage. The grocery list
  (recipe-app.grocery) and recipes saved on this phone
  (recipe-app.userRecipes) stay where they are.

  Paths are relative to this file, so they still work in the GitHub Pages
  folder /recipe-app/.
*/

var CACHE = "cabo-cooks-v1";

var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data/recipes.json",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

function isRecipeData(url) {
  return url.pathname.slice(-17) === "data/recipes.json";
}

function putInCache(request, response) {
  if (!response || !response.ok) {
    return;
  }
  var copy = response.clone();
  caches.open(CACHE).then(function (cache) {
    cache.put(request, copy).catch(function () {
      // A redirect or an odd response cannot be stored. The page still loads.
    });
  }).catch(function () {});
}

function fromCache(request) {
  return caches.match(request).then(function (cached) {
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      return caches.match("./index.html");
    }
    if (isRecipeData(new URL(request.url))) {
      return caches.match("./data/recipes.json");
    }
    return null;
  });
}

function networkFirst(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      putInCache(request, response);
      return response;
    }
    return fromCache(request).then(function (cached) {
      return cached || response;
    });
  }).catch(function () {
    return fromCache(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return new Response("", { status: 504, statusText: "Offline" });
    });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) {
      return cached;
    }
    return fetch(request).then(function (response) {
      putInCache(request, response);
      return response;
    });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var deletions = [];
      var i;
      for (i = 0; i < keys.length; i++) {
        if (keys[i] !== CACHE) {
          deletions.push(caches.delete(keys[i]));
        }
      }
      return Promise.all(deletions);
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url;

  if (request.method !== "GET") {
    return;
  }

  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  // Leave sw.js itself to the network, so a new copy of this file can install.
  if (url.pathname.slice(-6) === "/sw.js") {
    return;
  }

  if (request.mode === "navigate" || isRecipeData(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
