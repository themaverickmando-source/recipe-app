/*
  Manolo's recipe book.

  What this file does, in order:
    1. Load the recipes. The starting book is data/recipes.json. Recipes
       you add or edit, and seed recipes you delete, are saved on the
       phone in a separate note and laid on top of that file. A newer
       copy of the file can add recipes without erasing your changes.
    2. Draw a card for each recipe, and filter that list as you type.
    3. Open one recipe when the address ends with #recipe/<id>.
    4. On that recipe, − and + change how many people you are cooking for.
       Ingredient amounts on the screen scale to match. The saved recipe
       is never edited by those buttons.
    5. Add those scaled ingredients to a grocery list (#list). The same
       ingredient from two recipes becomes one line. The list is saved
       on the phone, in its own note, separate from the recipes.
    6. Start cooking opens one step at a time (#cook/<id>/<step>, step
       numbers start at 1). Back, Next, and a sideways swipe move between
       steps. The screen stays awake while that page is open, when the
       phone allows it.
    7. Add recipe (#new) and Edit (#edit/<id>) open a form. Save writes
       that recipe on this phone and opens it. Cancel leaves without
       saving. Delete asks first, then removes the recipe from this phone.

  The address hash is the part after the # sign. Changing it does not
  reload the page, and the phone's Back button walks back through those
  changes. Example: #recipe/5 is "Baked shrimp fra diavolo". #cook/5/2
  is step 2 of that recipe. #list is the grocery list.

  There is no framework and no build step. This script is plain JavaScript
  that the browser runs from the <script> tag at the bottom of index.html.
*/

// The list on screen: the seed file, plus this phone's adds and edits,
// minus seed recipes this phone has deleted. Empty until loading finishes.
var recipes = [];

// The starting book from data/recipes.json, or the offline copy of that
// file. User edits are not written into this list.
var seedRecipes = [];

// This phone's adds, edits, and deletions. See readUserState.
var userState = { recipes: [], deletedIds: [] };

// True after the list is ready. Stops search from running too early.
var ready = false;

// True when the recipe file and the offline copy both failed.
var loadFailed = false;

// Where the list was scrolled, so Back returns to the same spot.
var listScrollY = 0;

// How many people the open recipe is scaled for. This lives only on the
// screen. Nothing here is written to localStorage.
// Opening a recipe from the list starts at the number written in the
// recipe. Moving between that recipe and its cooking steps keeps the
// count, so the cooking screen shows the amounts you just picked.
var chosenServings = 0;

// The recipe id that chosenServings belongs to. Empty when the count
// should be read from the recipe again (home, grocery list, another recipe).
var servingsForId = "";

// The − button stops at 1. The + button stops at 24, enough for a crowd
// and not so high that the amounts become nonsense.
var MIN_SERVINGS = 1;
var MAX_SERVINGS = 24;

// The grocery list currently on this phone.
// Shape: { recipes: [ ... ], checked: [ ... ] }. See readGrocery.
var grocery = { recipes: [], checked: [] };

// True while "Clear the whole grocery list?" is on screen.
var clearConfirmOpen = false;

// True while a recipe that is already on the list is asking
// "Update it?" instead of adding a second copy.
var updateOfferOpen = false;

// Timers that hide the short "Added" / "Removed" messages.
var detailNoticeTimer = 0;
var listNoticeTimer = 0;

// Finger-down point for a sideways swipe on the cooking screen.
// Null when no swipe is in progress.
var cookSwipe = null;

// True while the ingredients panel on the cooking screen is open,
// so Next and Back keep it open. Leaving cooking mode starts it closed.
var cookIngredientsOpen = false;
var cookIngredientsFor = "";

// The screen wake lock held during cooking, or null when we do not have one.
// wakeRequest throws away a reply that arrives after we have left the screen.
var wakeLock = null;
var wakeRequest = 0;

// Fractions a cook already knows from cups and spoons.
// Each row is [numerator, denominator, glyph we print].
// 1.5 becomes 1½, 0.333 becomes ⅓, and a whole number stays a whole number.
var COOKING_FRACTIONS = [
  [1, 8, "⅛"],
  [1, 4, "¼"],
  [1, 3, "⅓"],
  [3, 8, "⅜"],
  [1, 2, "½"],
  [5, 8, "⅝"],
  [2, 3, "⅔"],
  [3, 4, "¾"],
  [7, 8, "⅞"]
];

// Package words, as [singular, plural].
// Only the last word of a unit is swapped, so "28-oz cans" can read
// "28-oz can" while the "28-oz" and the saved recipe stay as written.
// Add another row here to teach the app a new package word.
var PACKAGE_WORDS = [
  ["can", "cans"],
  ["jar", "jars"],
  ["package", "packages"],
  ["packet", "packets"],
  ["box", "boxes"],
  ["bag", "bags"],
  ["bottle", "bottles"],
  ["carton", "cartons"],
  ["tin", "tins"],
  ["pouch", "pouches"],
  ["pack", "packs"],
  ["container", "containers"],
  ["tub", "tubs"]
];

// localStorage is a small notebook the browser keeps for this website,
// on this phone. GitHub Pages hosts every project on one shared host
// (themaverickmando-source.github.io), so the key names start with
// "recipe-app." and will not collide with a different project.
//
// recipe-app.recipes is only an offline copy of data/recipes.json.
// It is not the user's edits. An older version of this app treated
// that key as the whole book and wrote recipe-app.data-version beside
// it. That version key is no longer read. Leaving it on the phone does
// not affect the grocery list or the recipes.
var RECIPES_KEY = "recipe-app.recipes";

// A different key from the recipes, so clearing the grocery list
// never deletes the recipe book. Same "recipe-app." prefix so it
// will not collide with another project on this GitHub Pages host.
var GROCERY_KEY = "recipe-app.grocery";

// Adds, edits, and deletions, kept separate from the seed file so a
// future update of data/recipes.json can add recipes without wiping
// what this phone changed.
// Shape: { recipes: [ ...recipe objects... ], deletedIds: [ "1", ... ] }.
// An edited seed recipe is stored in recipes with the same id, and that
// copy wins. deletedIds lists seed recipes this phone removed.
var USER_KEY = "recipe-app.userRecipes";

// --- Small helpers -------------------------------------------------------

// Turn a value into safe text for HTML, so a "<" in a recipe cannot
// break the page.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "Aioli", "aioli", and "aïoli" all become "aioli".
// normalize("NFD") splits ï into a plain i plus a separate accent mark.
// The replace then deletes those accent marks (Unicode U+0300 to U+036F).
function fold(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function minutesLabel(count) {
  if (count === 1) {
    return "1 minute";
  }
  return count + " minutes";
}

// Time, cuisine, and protein. Servings are not on this line.
// The card does not need them, and the recipe screen has − and + buttons
// so the count is not written twice.
// Minutes are left off when the recipe has none. A recipe you add can
// leave that box blank.
function metaLine(recipe) {
  var bits = [];
  var minutes = Number(recipe.total_minutes);
  if (minutes > 0) {
    bits.push(minutesLabel(minutes));
  }
  if (recipe.cuisine) {
    bits.push(recipe.cuisine);
  }
  if (recipe.protein) {
    bits.push(recipe.protein);
  }
  return bits.join(" · ");
}

// newServings / baseServings. This is 1 when the cook has not moved the
// count. A missing base would divide by zero, so we leave amounts alone.
function scaleFor(recipe, servings) {
  var base = Number(recipe.servings);
  if (!base || base <= 0) {
    return 1;
  }
  return servings / base;
}

// Turn a number into text a cook can read, and the number that text means.
// Whole numbers stay whole (2, not 2.0). Values near a kitchen fraction
// use that glyph, so 1.5 is 1½ and 0.333 is ⅓.
// number is that same amount (1.5, not the raw 1.499999), so a package
// word can agree with the digits on screen.
function roundAmount(value) {
  var thousandths = Math.round(value * 1000);
  if (thousandths < 0) {
    thousandths = 0;
  }

  var whole = Math.floor(thousandths / 1000);
  var remainder = thousandths - whole * 1000;

  // Start by assuming the leftover rounds down to the whole number.
  var bestDiff = remainder;
  var bestGlyph = "";
  var bestDenom = 1;
  var bestCarry = 0;
  var bestFraction = 0;

  function consider(diff, glyph, denom, carry, fraction) {
    // On a tie, keep the simpler fraction (smaller denominator).
    if (diff < bestDiff || (diff === bestDiff && denom < bestDenom)) {
      bestDiff = diff;
      bestGlyph = glyph;
      bestDenom = denom;
      bestCarry = carry;
      bestFraction = fraction;
    }
  }

  // A leftover near 1000 is really the next whole number.
  consider(1000 - remainder, "", 1, 1, 0);

  var i;
  for (i = 0; i < COOKING_FRACTIONS.length; i++) {
    var numer = COOKING_FRACTIONS[i][0];
    var denom = COOKING_FRACTIONS[i][1];
    var glyph = COOKING_FRACTIONS[i][2];
    var target = Math.round((1000 * numer) / denom);
    consider(Math.abs(remainder - target), glyph, denom, 0, numer / denom);
  }

  whole = whole + bestCarry;

  // A speck that would print as 0 still shows the smallest spoon mark,
  // so the ingredient does not disappear.
  if (thousandths > 0 && whole === 0 && bestGlyph === "") {
    return { text: "⅛", number: 1 / 8 };
  }

  var text;
  if (bestGlyph === "") {
    text = String(whole);
  } else if (whole === 0) {
    text = bestGlyph;
  } else {
    text = String(whole) + bestGlyph;
  }
  return { text: text, number: whole + bestFraction };
}

// One can, or part of one, reads as singular. More than one stays plural.
// "oz", "tsp", "cups", and "cloves" are not package words, so they are
// returned unchanged. The stored unit string is never edited.
function unitForCount(unit, count) {
  var words = String(unit).split(" ");
  var last = words[words.length - 1].toLowerCase();
  var i;

  for (i = 0; i < PACKAGE_WORDS.length; i++) {
    var singular = PACKAGE_WORDS[i][0];
    var plural = PACKAGE_WORDS[i][1];
    if (last === singular || last === plural) {
      words[words.length - 1] = count > 1 ? plural : singular;
      return words.join(" ");
    }
  }
  return unit;
}

// amount is null for "to taste" items (lemon, parmesan, a handful of herbs).
// Those stay "to taste" at every serving count.
//
// scale multiplies a copy of the amount. ingredient.amount itself is not
// changed, so the recipe saved on the phone stays as written.
//
// A package size such as "28-oz cans" lives in the unit, and the amount is
// how many packages. Scaling changes the count (2 becomes 1) and leaves the
// "28-oz" alone. The last word follows the count: "1 28-oz can",
// "½ 28-oz can", "2 28-oz cans".
function amountText(ingredient, scale) {
  if (ingredient.amount === null || typeof ingredient.amount === "undefined") {
    return "to taste";
  }
  var rounded = roundAmount(ingredient.amount * scale);
  var text = rounded.text;
  if (ingredient.unit) {
    text += " " + unitForCount(ingredient.unit, rounded.number);
  }
  return text;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    // Private mode and some locked-down browsers refuse storage. Keep going.
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

// --- Loading and saving --------------------------------------------------

// The last seed file we managed to read. Used only when this visit cannot
// reach data/recipes.json, so the book still opens offline.
function readSeedCache() {
  var raw = storageGet(RECIPES_KEY);
  var parsed;
  if (!raw) {
    return null;
  }
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

function writeSeedCache(list) {
  storageSet(RECIPES_KEY, JSON.stringify(list));
}

// This phone's own changes. A bad note is treated as "no changes" so a
// broken value cannot hide the seed recipes or the grocery list.
function readUserState() {
  var raw = storageGet(USER_KEY);
  var parsed;
  if (!raw) {
    return { recipes: [], deletedIds: [] };
  }
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { recipes: [], deletedIds: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { recipes: [], deletedIds: [] };
  }
  return {
    recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
    deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : []
  };
}

// Write the note first. The on-screen list changes only after that works,
// so a full notebook does not pretend the recipe was saved.
function writeUserState(next) {
  if (!storageSet(USER_KEY, JSON.stringify(next))) {
    return false;
  }
  userState = next;
  recipes = mergeRecipes(seedRecipes, userState);
  return true;
}

// Seed recipes, in file order, with this phone's copy used when the id
// matches. Seed ids listed in deletedIds are skipped. Recipes you added
// (ids that are not in the file) are appended.
function mergeRecipes(seed, state) {
  var deleted = {};
  var overlays = {};
  var seen = {};
  var result = [];
  var list = state && Array.isArray(state.recipes) ? state.recipes : [];
  var gone = state && Array.isArray(state.deletedIds) ? state.deletedIds : [];
  var i, id, recipe;

  for (i = 0; i < gone.length; i++) {
    deleted[String(gone[i])] = true;
  }
  for (i = 0; i < list.length; i++) {
    recipe = list[i];
    if (!recipe || recipe.id === null || typeof recipe.id === "undefined") {
      continue;
    }
    overlays[String(recipe.id)] = recipe;
  }

  for (i = 0; i < seed.length; i++) {
    if (!seed[i] || seed[i].id === null || typeof seed[i].id === "undefined") {
      continue;
    }
    id = String(seed[i].id);
    seen[id] = true;
    if (deleted[id]) {
      continue;
    }
    if (overlays[id]) {
      result.push(overlays[id]);
    } else {
      result.push(seed[i]);
    }
  }

  for (i = 0; i < list.length; i++) {
    recipe = list[i];
    if (!recipe || recipe.id === null || typeof recipe.id === "undefined") {
      continue;
    }
    id = String(recipe.id);
    if (seen[id] || deleted[id]) {
      continue;
    }
    result.push(recipe);
  }

  return result;
}

// Read the seed file when we can, so a new recipe in that file shows up
// on the next visit. Fall back to the offline copy when we cannot.
// Then lay this phone's changes on top.
async function loadRecipes() {
  var seed = null;
  var response;
  var fresh;

  try {
    // Relative path, so it works in the GitHub Pages subfolder.
    response = await fetch("data/recipes.json");
    if (response.ok) {
      fresh = await response.json();
      if (Array.isArray(fresh)) {
        seed = fresh;
        writeSeedCache(fresh);
      }
    }
  } catch (error) {
    seed = null;
  }

  if (!seed) {
    seed = readSeedCache();
  }
  if (!seed) {
    throw new Error("Could not load data/recipes.json");
  }

  seedRecipes = seed;
  userState = readUserState();
  return mergeRecipes(seedRecipes, userState);
}

function showLoadError() {
  var list = document.getElementById("list");
  var message = document.createElement("p");
  loadFailed = true;
  list.innerHTML = "";
  message.className = "empty";
  message.textContent = "The recipes could not be loaded. Open this site from GitHub Pages, or run a local web server in this folder, then refresh.";
  list.appendChild(message);
}

// --- Search --------------------------------------------------------------

// Text we are willing to match: title, cuisine, protein, tags, ingredient names.
// Steps are left out on purpose, so a search finds a dish, not a cooking word.
function recipeSearchText(recipe) {
  var parts = [recipe.title, recipe.cuisine, recipe.protein];
  var tags = recipe.tags || [];
  var ingredients = recipe.ingredients || [];
  var i;

  for (i = 0; i < tags.length; i++) {
    parts.push(tags[i]);
  }
  for (i = 0; i < ingredients.length; i++) {
    parts.push(ingredients[i].name);
  }
  return fold(parts.join("\n"));
}

// The list is short, so we just scan it again on every keystroke.
function matchingRecipes(query) {
  var needle = fold(query.trim());
  if (!needle) {
    return recipes.slice();
  }

  var found = [];
  for (var i = 0; i < recipes.length; i++) {
    // includes is true when the typed letters show up in the recipe text.
    if (recipeSearchText(recipes[i]).includes(needle)) {
      found.push(recipes[i]);
    }
  }
  return found;
}

// --- Drawing the home screen ---------------------------------------------

function tagsHtml(tags) {
  if (!tags || tags.length === 0) {
    return "";
  }
  var html = "<ul class=\"tags\">";
  for (var i = 0; i < tags.length; i++) {
    html += "<li>" + escapeHtml(tags[i]) + "</li>";
  }
  html += "</ul>";
  return html;
}

function recipeCardHtml(recipe) {
  var href = recipeHref(recipe.id);
  var meta = metaLine(recipe);
  var metaHtml = meta ? "<p class=\"meta\">" + escapeHtml(meta) + "</p>" : "";
  return (
    "<a class=\"card\" href=\"" + href + "\">" +
      "<h2>" + escapeHtml(recipe.title) + "</h2>" +
      metaHtml +
      tagsHtml(recipe.tags) +
    "</a>"
  );
}

function renderList() {
  var query = document.getElementById("search").value;
  var found = matchingRecipes(query);
  var list = document.getElementById("list");
  var empty = document.getElementById("empty");
  var count = document.getElementById("count");
  var html = "";
  var i;

  if (found.length === 0 && query.trim()) {
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No recipes match. Try a different word.";
    count.hidden = true;
    return;
  }

  if (found.length === 0) {
    count.hidden = true;
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No recipes yet. Add one to get started.";
    return;
  }

  empty.hidden = true;

  count.hidden = false;
  count.textContent = found.length === 1 ? "1 recipe" : found.length + " recipes";

  for (i = 0; i < found.length; i++) {
    html += recipeCardHtml(found[i]);
  }
  list.innerHTML = html;
}

// --- Drawing one recipe --------------------------------------------------

function ingredientHtml(ingredient, scale) {
  var prep = ingredient.prep
    ? "<span class=\"prep\">" + escapeHtml(ingredient.prep) + "</span>"
    : "";
  return (
    "<li>" +
      "<strong class=\"amount\">" + escapeHtml(amountText(ingredient, scale)) + "</strong> " +
      escapeHtml(ingredient.name) +
      prep +
    "</li>"
  );
}

// The − and + buttons sit on either side of the current count.
// Reset is only offered after the count has moved off the recipe's own number.
function servingsControlHtml(recipe, servings) {
  var lessDisabled = servings <= MIN_SERVINGS ? " disabled" : "";
  var moreDisabled = servings >= MAX_SERVINGS ? " disabled" : "";
  var reset = "";

  if (servings !== recipe.servings) {
    reset =
      "<button type=\"button\" class=\"servings-reset\" id=\"servings-reset\">" +
        "Reset to " + recipe.servings +
      "</button>";
  }

  return (
    "<h2>Servings</h2>" +
    "<div class=\"servings\">" +
      "<div class=\"servings-row\">" +
        "<button type=\"button\" class=\"stepper\" id=\"servings-less\" aria-label=\"Fewer servings\"" + lessDisabled + ">−</button>" +
        "<p class=\"servings-count\" id=\"servings-count\" aria-live=\"polite\">" +
          "<span class=\"servings-num\">" + servings + "</span> " +
          (servings === 1 ? "serving" : "servings") +
        "</p>" +
        "<button type=\"button\" class=\"stepper\" id=\"servings-more\" aria-label=\"More servings\"" + moreDisabled + ">+</button>" +
      "</div>" +
      reset +
    "</div>"
  );
}

function recipeDetailHtml(recipe, servings) {
  var ingredients = recipe.ingredients || [];
  var steps = recipe.steps || [];
  var scale = scaleFor(recipe, servings);
  var ingredientList = "";
  var stepList = "<ol class=\"steps\">";
  var i;

  for (i = 0; i < ingredients.length; i++) {
    ingredientList += ingredientHtml(ingredients[i], scale);
  }
  for (i = 0; i < steps.length; i++) {
    stepList += "<li>" + escapeHtml(steps[i]) + "</li>";
  }
  stepList += "</ol>";

  var source = recipe.source
    ? "<p class=\"source\">Source: " + escapeHtml(recipe.source) + "</p>"
    : "";
  var meta = metaLine(recipe);
  var metaHtml = meta ? "<p class=\"meta\">" + escapeHtml(meta) + "</p>" : "";

  // href="#" clears the recipe id, which shows the list again.
  // Opening a card already pushed a history entry, so the phone Back
  // button returns to the list even if you never tap this one.
  return (
    "<a class=\"back\" href=\"#\">← Back to recipes</a>" +
    "<h1>" + escapeHtml(recipe.title) + "</h1>" +
    "<a class=\"secondary edit-link\" href=\"" + editHref(recipe.id) + "\">Edit</a>" +
    metaHtml +
    source +
    tagsHtml(recipe.tags) +
    servingsControlHtml(recipe, servings) +
    startCookingHtml(recipe) +
    groceryControlsHtml(recipe) +
    "<h2>Ingredients</h2>" +
    "<ul class=\"ingredients\">" + ingredientList + "</ul>" +
    "<h2>Steps</h2>" +
    stepList
  );
}

// Big button under the serving count. The cooking address carries the
// recipe id and step 1, so a reload opens on that step.
function startCookingHtml(recipe) {
  var steps = recipe.steps || [];
  if (!steps.length) {
    return "";
  }
  return "<a class=\"cook-start\" href=\"" + cookHref(recipe.id, 1) + "\">Start cooking</a>";
}

function missingRecipeHtml() {
  return (
    "<a class=\"back\" href=\"#\">← Back to recipes</a>" +
    "<h1>Recipe not found</h1>" +
    "<p>That recipe is not saved on this phone.</p>"
  );
}

function findRecipe(id) {
  var wanted = String(id);
  for (var i = 0; i < recipes.length; i++) {
    if (String(recipes[i].id) === wanted) {
      return recipes[i];
    }
  }
  return null;
}

// "#recipe/5" -> "5". "#list" and a bare "#" are not recipe ids.
function recipeIdFromHash() {
  var match = /^#recipe\/([^/]+)$/.exec(window.location.hash);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function recipeHref(id) {
  return "#recipe/" + encodeURIComponent(id);
}

// "#new" is a blank form. "#edit/5" edits the recipe with that id.
function editHref(id) {
  return "#edit/" + encodeURIComponent(id);
}

function isNewHash() {
  return window.location.hash === "#new";
}

function editIdFromHash() {
  var match = /^#edit\/([^/]+)$/.exec(window.location.hash);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

// "#cook/5/2" is recipe 5, step 2. Step numbers start at 1.
// "#cook/5" alone is treated as step 1.
function cookHref(id, step) {
  return "#cook/" + encodeURIComponent(id) + "/" + step;
}

function cookTargetFromHash() {
  var match = /^#cook\/([^/]+)(?:\/([^/]+))?$/.exec(window.location.hash);
  if (!match) {
    return null;
  }
  return {
    id: decodeURIComponent(match[1]),
    step: match[2] ? decodeURIComponent(match[2]) : "1"
  };
}

// True when two hashes name the same address, even if one is encoded.
function hashesMatch(a, b) {
  if (a === b) {
    return true;
  }
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch (error) {
    return false;
  }
}

// The address step is 1-based. Anything that is not a whole number
// lands on step 1. A number past the end lands on the last step.
function clampedStep(raw, count) {
  var text = String(raw);
  var n;
  if (!/^[0-9]+$/.test(text)) {
    return 1;
  }
  n = parseInt(text, 10);
  if (n < 1 || count < 1) {
    return 1;
  }
  if (n > count) {
    return count;
  }
  return n;
}

// "#list" is the grocery list. "#recipe/5" is one recipe.
// "#cook/5/2" is cooking. "#new" and "#edit/5" are the form.
// Anything else, including no hash, is home.
function screenFromHash() {
  if (window.location.hash === "#list") {
    return "list";
  }
  if (isNewHash() || editIdFromHash()) {
    return "editor";
  }
  if (cookTargetFromHash()) {
    return "cook";
  }
  if (recipeIdFromHash()) {
    return "recipe";
  }
  return "home";
}

function showFromHash() {
  var home = document.getElementById("home");
  var detail = document.getElementById("detail");
  var listScreen = document.getElementById("grocery");
  var cook = document.getElementById("cook");
  var editor = document.getElementById("editor");
  var next = screenFromHash();

  // Opening a screen is a fresh visit. The update question and the
  // clear-all question belong to the screen we just left.
  updateOfferOpen = false;
  if (next !== "list") {
    clearConfirmOpen = false;
  }

  // Remember the list position only when we are actually leaving it.
  if (next !== "home" && !home.hidden) {
    listScrollY = window.scrollY;
  }

  // The bottom bar and the wake lock follow the screen, before we draw.
  syncCookingChrome(next);

  // Home, the grocery list, and the form forget the serving count.
  // The next open of a recipe starts from the number written in that recipe.
  if (next !== "recipe" && next !== "cook") {
    servingsForId = "";
  }

  // Leaving the form throws away anything that was not saved.
  if (next !== "editor") {
    editor.hidden = true;
    editor.innerHTML = "";
  }

  if (next === "home") {
    var y = listScrollY;
    detail.hidden = true;
    detail.innerHTML = "";
    listScreen.hidden = true;
    cook.hidden = true;
    cook.innerHTML = "";
    home.hidden = false;
    document.title = "Recipes";
    updateNav();
    window.scrollTo(0, y);
    return;
  }

  if (next === "list") {
    home.hidden = true;
    detail.hidden = true;
    detail.innerHTML = "";
    cook.hidden = true;
    cook.innerHTML = "";
    listScreen.hidden = false;
    document.title = "Grocery list";
    renderGrocery();
    window.scrollTo(0, 0);
    return;
  }

  if (next === "cook") {
    home.hidden = true;
    detail.hidden = true;
    detail.innerHTML = "";
    listScreen.hidden = true;
    cook.hidden = false;
    updateNav();
    drawCook();
    return;
  }

  if (next === "editor") {
    home.hidden = true;
    detail.hidden = true;
    detail.innerHTML = "";
    listScreen.hidden = true;
    cook.hidden = true;
    cook.innerHTML = "";
    editor.hidden = false;
    updateNav();
    drawEditor();
    return;
  }

  home.hidden = true;
  listScreen.hidden = true;
  cook.hidden = true;
  cook.innerHTML = "";
  detail.hidden = false;
  window.scrollTo(0, 0);
  updateNav();

  var recipe = findRecipe(recipeIdFromHash());
  if (!recipe) {
    chosenServings = 0;
    servingsForId = "";
    detail.innerHTML = missingRecipeHtml();
    document.title = "Recipe not found";
    return;
  }

  adoptServings(recipe);
  drawDetail(recipe);
}

// Keep the count already on screen when it belongs to this recipe.
// Otherwise start from the number written in the recipe, clamped to 1..24.
function adoptServings(recipe) {
  var count;
  if (String(servingsForId) === String(recipe.id)) {
    return;
  }
  count = Number(recipe.servings);
  if (!count || count < MIN_SERVINGS) {
    count = MIN_SERVINGS;
  }
  if (count > MAX_SERVINGS) {
    count = MAX_SERVINGS;
  }
  chosenServings = count;
  servingsForId = String(recipe.id);
}

// Redraw the open recipe at chosenServings. Reads the recipe, does not write it.
function drawDetail(recipe) {
  // A redraw replaces the confirmation line, so cancel its hide-timer.
  // The caller can show a new message after this returns.
  if (detailNoticeTimer) {
    clearTimeout(detailNoticeTimer);
    detailNoticeTimer = 0;
  }
  var detail = document.getElementById("detail");
  detail.innerHTML = recipeDetailHtml(recipe, chosenServings);
  document.title = recipe.title;
}

// Keep the count inside 1..24, then redraw. The same number means the cook
// is already at the end of the range, so the page stays as it is.
function setServings(next) {
  var recipe = findRecipe(recipeIdFromHash());
  if (!recipe) {
    return;
  }
  if (next < MIN_SERVINGS) {
    next = MIN_SERVINGS;
  }
  if (next > MAX_SERVINGS) {
    next = MAX_SERVINGS;
  }
  if (next === chosenServings) {
    return;
  }
  chosenServings = next;
  drawDetail(recipe);
}

// Walk up from the thing that was tapped until we find a button, if any.
function clickedButton(event) {
  var node = event.target;
  while (node) {
    if (node.tagName === "BUTTON") {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

function onDetailClick(event) {
  var button = clickedButton(event);
  if (!button) {
    return;
  }
  if (button.id === "servings-less") {
    setServings(chosenServings - 1);
  } else if (button.id === "servings-more") {
    setServings(chosenServings + 1);
  } else if (button.id === "servings-reset") {
    var recipe = findRecipe(recipeIdFromHash());
    if (recipe) {
      setServings(recipe.servings);
    }
  } else if (button.id === "add-grocery") {
    onAddGrocery();
  } else if (button.id === "grocery-update-yes") {
    onUpdateGrocery();
  } else if (button.id === "grocery-update-no") {
    updateOfferOpen = false;
    var current = findRecipe(recipeIdFromHash());
    if (current) {
      drawDetail(current);
    }
  }
}

// --- Grocery list --------------------------------------------------------
//
// What we save (localStorage key "recipe-app.grocery"):
//   recipes: one entry per recipe you added. Each entry remembers the
//            title, the serving count you had picked, and a copy of the
//            ingredients already multiplied for that count.
//   checked: keys of lines you have tapped off. A key is the folded
//            name, a separator, and the folded unit.
//
// The copy is on purpose. Changing servings on the recipe screen later
// does not silently change the grocery list. Tap Update when you want
// the list to follow a new count.
//
// Matching lines are combined when you look at the list, not when you
// save. "Aïoli" + "tsp" and "aioli" + "TSP" are the same line. A null
// amount ("to taste") is not turned into 0, and it is not added up.

function emptyGrocery() {
  return { recipes: [], checked: [] };
}

function readGrocery() {
  var raw = storageGet(GROCERY_KEY);
  if (!raw) {
    return emptyGrocery();
  }
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.recipes) || !Array.isArray(parsed.checked)) {
      return emptyGrocery();
    }
    return parsed;
  } catch (error) {
    return emptyGrocery();
  }
}

function writeGrocery() {
  storageSet(GROCERY_KEY, JSON.stringify(grocery));
}

// "2 servings", or "1 serving" when the count is one.
function servingsPhrase(count) {
  if (count === 1) {
    return "1 serving";
  }
  return count + " servings";
}

function findGroceryRecipe(id) {
  var wanted = String(id);
  var i;
  for (i = 0; i < grocery.recipes.length; i++) {
    if (String(grocery.recipes[i].id) === wanted) {
      return grocery.recipes[i];
    }
  }
  return null;
}

// Copy the ingredients at the serving count on screen.
// amount null stays null. Every other amount is multiplied once, here,
// and the grocery list stores that result.
function snapshotRecipe(recipe, servings) {
  var scale = scaleFor(recipe, servings);
  var ingredients = recipe.ingredients || [];
  var saved = [];
  var i, item, amount;

  for (i = 0; i < ingredients.length; i++) {
    item = ingredients[i];
    if (item.amount === null || typeof item.amount === "undefined") {
      amount = null;
    } else {
      amount = item.amount * scale;
    }
    saved.push({
      name: item.name,
      amount: amount,
      unit: item.unit || ""
    });
  }

  return {
    id: String(recipe.id),
    title: recipe.title,
    servings: servings,
    ingredients: saved
  };
}

function addRecipeToGrocery(recipe, servings) {
  if (findGroceryRecipe(recipe.id)) {
    return false;
  }
  grocery.recipes.push(snapshotRecipe(recipe, servings));
  writeGrocery();
  return true;
}

function updateRecipeOnGrocery(recipe, servings) {
  var id = String(recipe.id);
  var next = [];
  var replaced = false;
  var i;

  for (i = 0; i < grocery.recipes.length; i++) {
    if (String(grocery.recipes[i].id) === id) {
      // Keep a single copy even if an old save somehow had two.
      if (!replaced) {
        next.push(snapshotRecipe(recipe, servings));
        replaced = true;
      }
    } else {
      next.push(grocery.recipes[i]);
    }
  }
  if (!replaced) {
    next.push(snapshotRecipe(recipe, servings));
  }
  grocery.recipes = next;
  pruneChecked();
  writeGrocery();
}

function removeRecipeFromGrocery(id) {
  var wanted = String(id);
  var next = [];
  var removed = null;
  var i;

  for (i = 0; i < grocery.recipes.length; i++) {
    if (String(grocery.recipes[i].id) === wanted) {
      removed = grocery.recipes[i];
    } else {
      next.push(grocery.recipes[i]);
    }
  }
  grocery.recipes = next;
  pruneChecked();
  writeGrocery();
  return removed;
}

// Folded name + folded unit. Case and accents do not count as different.
// The separator is a character that will not show up in an ingredient name.
function itemKey(name, unit) {
  return fold(name) + "\u0000" + fold(unit || "");
}

function rememberRecipe(row, entry) {
  var id = String(entry.id);
  var i;
  for (i = 0; i < row.recipes.length; i++) {
    if (row.recipes[i].id === id) {
      return;
    }
  }
  row.recipes.push({
    id: id,
    title: entry.title || "Recipe"
  });
}

// One row per name + unit. Amounts are summed. Null amounts stay null
// unless some recipe also gave a real number for that same name and unit.
function combinedItems() {
  var order = [];
  var map = {};
  var r, i, entry, ingredient, key, row, add;

  for (r = 0; r < grocery.recipes.length; r++) {
    entry = grocery.recipes[r];
    if (!entry || !Array.isArray(entry.ingredients)) {
      continue;
    }
    for (i = 0; i < entry.ingredients.length; i++) {
      ingredient = entry.ingredients[i];
      if (!ingredient || !ingredient.name) {
        continue;
      }
      key = itemKey(ingredient.name, ingredient.unit);
      row = map[key];
      if (!row) {
        row = {
          key: key,
          name: ingredient.name,
          unit: ingredient.unit || "",
          amount: null,
          recipes: []
        };
        map[key] = row;
        order.push(row);
      }
      if (ingredient.amount !== null && typeof ingredient.amount !== "undefined") {
        add = Number(ingredient.amount);
        if (!isNaN(add)) {
          if (row.amount === null) {
            row.amount = 0;
          }
          // Thousandths match formatAmount, so 0.1 + 0.2 does not
          // become a long decimal the cook cannot use.
          row.amount = Math.round((row.amount + add) * 1000) / 1000;
        }
      }
      rememberRecipe(row, entry);
    }
  }

  return order;
}

// Drop check marks for lines that are no longer on the list.
// A line that is still there, from a recipe you did not remove, stays checked.
function pruneChecked() {
  var still = {};
  var items = combinedItems();
  var checks = [];
  var i;
  for (i = 0; i < items.length; i++) {
    still[items[i].key] = true;
  }
  for (i = 0; i < grocery.checked.length; i++) {
    if (still[grocery.checked[i]]) {
      checks.push(grocery.checked[i]);
    }
  }
  grocery.checked = checks;
}

// Checked rows go last. Otherwise alphabetical by name, then by unit,
// so two units of butter sit next to each other.
function compareGroceryItems(a, b) {
  if (a.checked !== b.checked) {
    if (a.checked) {
      return 1;
    }
    return -1;
  }
  if (a.nameKey < b.nameKey) {
    return -1;
  }
  if (a.nameKey > b.nameKey) {
    return 1;
  }
  if (a.unitKey < b.unitKey) {
    return -1;
  }
  if (a.unitKey > b.unitKey) {
    return 1;
  }
  return 0;
}

function itemsForDisplay() {
  var items = combinedItems();
  var checked = {};
  var i;

  for (i = 0; i < grocery.checked.length; i++) {
    checked[grocery.checked[i]] = true;
  }
  for (i = 0; i < items.length; i++) {
    items[i].checked = !!checked[items[i].key];
    items[i].nameKey = fold(items[i].name);
    items[i].unitKey = fold(items[i].unit || "");
  }
  items.sort(compareGroceryItems);
  return items;
}

function toggleChecked(key) {
  var next = [];
  var found = false;
  var i;
  for (i = 0; i < grocery.checked.length; i++) {
    if (grocery.checked[i] === key) {
      found = true;
    } else {
      next.push(grocery.checked[i]);
    }
  }
  if (!found) {
    next.push(key);
  }
  grocery.checked = next;
  writeGrocery();
}

// Remove every checked line from the saved recipes. A recipe with nothing
// left to buy is taken off the list too.
function clearCheckedItems() {
  var items = itemsForDisplay();
  var drop = {};
  var n = 0;
  var i, r, entry, kept, ingredient;

  for (i = 0; i < items.length; i++) {
    if (items[i].checked) {
      drop[items[i].key] = true;
      n = n + 1;
    }
  }
  if (n === 0) {
    return 0;
  }

  for (r = 0; r < grocery.recipes.length; r++) {
    entry = grocery.recipes[r];
    kept = [];
    if (!entry.ingredients) {
      entry.ingredients = [];
      continue;
    }
    for (i = 0; i < entry.ingredients.length; i++) {
      ingredient = entry.ingredients[i];
      if (!drop[itemKey(ingredient.name, ingredient.unit)]) {
        kept.push(ingredient);
      }
    }
    entry.ingredients = kept;
  }

  var recipesLeft = [];
  for (r = 0; r < grocery.recipes.length; r++) {
    if (grocery.recipes[r].ingredients && grocery.recipes[r].ingredients.length > 0) {
      recipesLeft.push(grocery.recipes[r]);
    }
  }
  grocery.recipes = recipesLeft;

  var checksLeft = [];
  for (i = 0; i < grocery.checked.length; i++) {
    if (!drop[grocery.checked[i]]) {
      checksLeft.push(grocery.checked[i]);
    }
  }
  grocery.checked = checksLeft;
  writeGrocery();
  return n;
}

function clearAllGrocery() {
  grocery = emptyGrocery();
  clearConfirmOpen = false;
  writeGrocery();
}

// The number on the Grocery list tab: how many combined lines are on the list.
function updateNav() {
  var countEl = document.getElementById("grocery-count");
  var recipesTab = document.getElementById("tab-recipes");
  var listTab = document.getElementById("tab-list");
  var total = combinedItems().length;

  if (!countEl || !recipesTab || !listTab) {
    return;
  }

  if (total > 0) {
    countEl.hidden = false;
    countEl.textContent = String(total);
  } else {
    countEl.hidden = true;
    countEl.textContent = "";
  }

  if (screenFromHash() === "list") {
    listTab.setAttribute("aria-current", "page");
    recipesTab.removeAttribute("aria-current");
  } else if (screenFromHash() === "cook") {
    // Cooking is neither tab. The bar is hidden, and neither one is current.
    recipesTab.removeAttribute("aria-current");
    listTab.removeAttribute("aria-current");
  } else {
    recipesTab.setAttribute("aria-current", "page");
    listTab.removeAttribute("aria-current");
  }
}

function showTimedNotice(id, text) {
  var el = document.getElementById(id);
  if (!el) {
    return;
  }
  el.hidden = false;
  el.textContent = text;

  if (id === "detail-notice") {
    if (detailNoticeTimer) {
      clearTimeout(detailNoticeTimer);
    }
    detailNoticeTimer = setTimeout(function () {
      var node = document.getElementById("detail-notice");
      if (node) {
        node.hidden = true;
        node.textContent = "";
      }
    }, 4000);
    return;
  }

  if (listNoticeTimer) {
    clearTimeout(listNoticeTimer);
  }
  listNoticeTimer = setTimeout(function () {
    var node = document.getElementById("grocery-notice");
    if (node) {
      node.hidden = true;
      node.textContent = "";
    }
  }, 4000);
}

function noticeSlot() {
  return "<p id=\"detail-notice\" class=\"notice\" role=\"status\" hidden></p>";
}

function offerHtml(saved) {
  var now = chosenServings;
  var previous = Number(saved.servings);
  var message;

  if (previous === now) {
    message = "This recipe is already on your grocery list at " +
      servingsPhrase(now) + ". Update it with the amounts shown now?";
  } else {
    message = "This recipe is already on your grocery list at " +
      servingsPhrase(previous) + ". Update it to " + servingsPhrase(now) + "?";
  }

  return (
    "<div class=\"offer\">" +
      "<p>" + escapeHtml(message) + "</p>" +
      "<button type=\"button\" class=\"add-grocery\" id=\"grocery-update-yes\">Update</button>" +
      "<button type=\"button\" class=\"secondary\" id=\"grocery-update-no\">Keep current</button>" +
    "</div>"
  );
}

function groceryControlsHtml(recipe) {
  var saved = findGroceryRecipe(recipe.id);
  if (updateOfferOpen && saved) {
    return (
      "<div class=\"grocery-controls\">" +
        offerHtml(saved) +
        noticeSlot() +
      "</div>"
    );
  }

  var label = saved ? "Update grocery list" : "Add to grocery list";
  return (
    "<div class=\"grocery-controls\">" +
      "<button type=\"button\" class=\"add-grocery\" id=\"add-grocery\">" +
        escapeHtml(label) +
      "</button>" +
      noticeSlot() +
    "</div>"
  );
}

function onAddGrocery() {
  var recipe = findRecipe(recipeIdFromHash());
  if (!recipe) {
    return;
  }
  // Already saved: ask before replacing. Never add a second copy.
  if (findGroceryRecipe(recipe.id)) {
    updateOfferOpen = true;
    drawDetail(recipe);
    return;
  }
  addRecipeToGrocery(recipe, chosenServings);
  drawDetail(recipe);
  showTimedNotice("detail-notice", "Added at " + servingsPhrase(chosenServings) + ".");
  updateNav();
}

function onUpdateGrocery() {
  var recipe = findRecipe(recipeIdFromHash());
  if (!recipe) {
    return;
  }
  updateRecipeOnGrocery(recipe, chosenServings);
  updateOfferOpen = false;
  drawDetail(recipe);
  showTimedNotice("detail-notice", "Updated to " + servingsPhrase(chosenServings) + ".");
  updateNav();
}

// Print the amount the same way as the recipe screen. Scale is 1 because
// we already multiplied by the serving change when the recipe was added.
// Whatever the recipe screen does with a unit, this line does too.
function groceryAmountText(item) {
  if (item.amount === null) {
    return "";
  }
  return amountText({ amount: item.amount, unit: item.unit }, 1);
}

function fromLine(item) {
  var titles = [];
  var i;
  for (i = 0; i < item.recipes.length; i++) {
    titles.push(item.recipes[i].title);
  }
  var who = titles.join(" · ");
  if (item.amount === null) {
    if (!who) {
      return "to taste";
    }
    return "to taste · " + who;
  }
  return who;
}

function itemLineHtml(item) {
  var name = escapeHtml(item.name);
  var shown = groceryAmountText(item);
  if (!shown) {
    return name;
  }
  return "<strong class=\"amount\">" + escapeHtml(shown) + "</strong> " + name;
}

function groceryItemHtml(item) {
  var pressed = item.checked ? "true" : "false";
  var checkedClass = item.checked ? " is-checked" : "";
  var tick = item.checked ? "✓" : "";
  return (
    "<button type=\"button\" class=\"grocery-item" + checkedClass + "\" data-key=\"" +
      encodeURIComponent(item.key) + "\" aria-pressed=\"" + pressed + "\">" +
      "<span class=\"tick\" aria-hidden=\"true\">" + tick + "</span>" +
      "<span class=\"grocery-text\">" +
        "<span class=\"grocery-line\">" + itemLineHtml(item) + "</span>" +
        "<span class=\"from\">" + escapeHtml(fromLine(item)) + "</span>" +
      "</span>" +
    "</button>"
  );
}

// Neighboring rows that share a name are wrapped together, so 1 tbsp
// butter and 1 pat butter read as one ingredient with two units.
// A name that only has one unit is just the row. The name is already on it.
function itemsHtml(list) {
  var html = "";
  var i = 0;

  while (i < list.length) {
    var start = i;
    var nameKey = list[i].nameKey;
    i = i + 1;
    while (i < list.length && list[i].nameKey === nameKey) {
      i = i + 1;
    }

    var block = "<ul class=\"grocery-items\">";
    var j;
    for (j = start; j < i; j++) {
      block += "<li>" + groceryItemHtml(list[j]) + "</li>";
    }
    block += "</ul>";

    if (i - start > 1) {
      html += "<section class=\"grocery-group\"><h3>" + escapeHtml(list[start].name) + "</h3>" + block + "</section>";
    } else {
      html += block;
    }
  }

  return html;
}

function recipeRowHtml(entry) {
  var servings = Number(entry.servings);
  var meta = "";
  var title = entry.title || "Recipe";

  if (!isNaN(servings) && servings > 0) {
    meta = "<p class=\"meta\">" + escapeHtml(servingsPhrase(servings)) + "</p>";
  }

  return (
    "<li class=\"grocery-recipe\">" +
      "<div class=\"grocery-recipe-text\">" +
        "<p class=\"grocery-recipe-title\">" + escapeHtml(title) + "</p>" +
        meta +
      "</div>" +
      "<button type=\"button\" class=\"remove-recipe\" data-remove=\"" + escapeHtml(String(entry.id)) + "\" aria-label=\"Remove " + escapeHtml(title) + "\">Remove</button>" +
    "</li>"
  );
}

function recipesSectionHtml() {
  if (!grocery.recipes.length) {
    return "";
  }
  var html = "<h2>On this list</h2><ul class=\"on-list\">";
  var i;
  for (i = 0; i < grocery.recipes.length; i++) {
    html += recipeRowHtml(grocery.recipes[i]);
  }
  html += "</ul>";
  return html;
}

function actionsHtml(items) {
  var checkedN = 0;
  var i;
  for (i = 0; i < items.length; i++) {
    if (items[i].checked) {
      checkedN = checkedN + 1;
    }
  }

  var disabled = checkedN === 0 ? " disabled" : "";
  var clearAll;

  if (clearConfirmOpen) {
    clearAll =
      "<div class=\"offer\">" +
        "<p>Clear the whole grocery list? This removes every recipe and item.</p>" +
        "<button type=\"button\" class=\"add-grocery\" id=\"clear-all-yes\">Clear all</button>" +
        "<button type=\"button\" class=\"secondary\" id=\"clear-all-no\">Cancel</button>" +
      "</div>";
  } else {
    clearAll = "<button type=\"button\" class=\"secondary\" id=\"clear-all\">Clear all</button>";
  }

  return (
    "<div class=\"grocery-actions\">" +
      "<button type=\"button\" class=\"secondary\" id=\"clear-checked\"" + disabled + ">Clear checked</button>" +
      clearAll +
    "</div>"
  );
}

function summaryText(items) {
  var itemText = items.length === 1 ? "1 item" : items.length + " items";
  var recipeText = grocery.recipes.length === 1 ? "1 recipe" : grocery.recipes.length + " recipes";
  return itemText + " from " + recipeText;
}

function renderGrocery() {
  var summary = document.getElementById("grocery-summary");
  var body = document.getElementById("grocery-body");
  var items = itemsForDisplay();
  var buy = [];
  var done = [];
  var html = "";
  var i;

  updateNav();

  if (!summary || !body) {
    return;
  }

  if (grocery.recipes.length === 0) {
    summary.textContent = "Nothing here yet.";
    body.innerHTML = "<p class=\"empty\">Your grocery list is empty. Open a recipe and tap Add to grocery list.</p>";
    return;
  }

  summary.textContent = summaryText(items);
  html = recipesSectionHtml();

  for (i = 0; i < items.length; i++) {
    if (items[i].checked) {
      done.push(items[i]);
    } else {
      buy.push(items[i]);
    }
  }

  if (buy.length) {
    html += "<h2>To buy</h2>" + itemsHtml(buy);
  }
  if (done.length) {
    html += "<h2>Checked</h2>" + itemsHtml(done);
  }
  html += actionsHtml(items);
  body.innerHTML = html;
}

function focusGroceryItem(encoded) {
  var buttons = document.querySelectorAll(".grocery-item");
  var i;
  for (i = 0; i < buttons.length; i++) {
    if (buttons[i].getAttribute("data-key") === encoded) {
      buttons[i].focus();
      return;
    }
  }
}

function onGroceryClick(event) {
  var button = clickedButton(event);
  var removed, encoded, n;

  if (!button) {
    return;
  }

  if (button.id === "clear-checked") {
    n = clearCheckedItems();
    clearConfirmOpen = false;
    renderGrocery();
    if (n === 1) {
      showTimedNotice("grocery-notice", "Cleared 1 checked item.");
    } else if (n > 1) {
      showTimedNotice("grocery-notice", "Cleared " + n + " checked items.");
    }
    return;
  }

  if (button.id === "clear-all") {
    clearConfirmOpen = true;
    renderGrocery();
    var yes = document.getElementById("clear-all-yes");
    if (yes) {
      yes.focus();
    }
    return;
  }

  if (button.id === "clear-all-no") {
    clearConfirmOpen = false;
    renderGrocery();
    return;
  }

  if (button.id === "clear-all-yes") {
    clearAllGrocery();
    renderGrocery();
    showTimedNotice("grocery-notice", "Cleared your grocery list.");
    return;
  }

  if (button.getAttribute("data-remove")) {
    removed = removeRecipeFromGrocery(button.getAttribute("data-remove"));
    clearConfirmOpen = false;
    renderGrocery();
    if (removed && removed.title) {
      showTimedNotice("grocery-notice", "Removed " + removed.title + ".");
    }
    return;
  }

  if (button.getAttribute("data-key")) {
    encoded = button.getAttribute("data-key");
    clearConfirmOpen = false;
    toggleChecked(decodeURIComponent(encoded));
    renderGrocery();
    focusGroceryItem(encoded);
  }
}

// --- Cooking mode --------------------------------------------------------
//
// One step on screen. The address is #cook/<id>/<step>, step starting at 1,
// so the phone Back button and a reload return to the same step.
// Back / Next (and a sideways swipe) only change that address. Done and
// Exit go back to #recipe/<id>.
//
// The ingredients panel uses the same amount text as the recipe screen,
// at the serving count already chosen there.

function wakeLockSupported() {
  try {
    return !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");
  } catch (error) {
    return false;
  }
}

function releaseSentinel(sentinel) {
  var done;
  if (!sentinel) {
    return;
  }
  try {
    if (sentinel.released) {
      return;
    }
    done = sentinel.release();
  } catch (error) {
    return;
  }
  if (done && typeof done.catch === "function") {
    done.catch(function () {
      // Already released, or the browser refused. Nothing to show.
    });
  }
}

// Ask the phone to keep the screen on. Any failure is ignored: cooking
// still works, the screen may just dim.
function requestWakeLock() {
  var ticket;
  var request;

  if (!wakeLockSupported()) {
    updateWakeNote();
    return;
  }
  if (wakeLock && !wakeLock.released) {
    updateWakeNote();
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }

  ticket = wakeRequest + 1;
  wakeRequest = ticket;

  try {
    request = navigator.wakeLock.request("screen");
  } catch (error) {
    return;
  }

  Promise.resolve(request).then(function (sentinel) {
    if (!sentinel || ticket !== wakeRequest || screenFromHash() !== "cook") {
      releaseSentinel(sentinel);
      return;
    }
    wakeLock = sentinel;
    try {
      sentinel.addEventListener("release", function () {
        if (wakeLock === sentinel) {
          wakeLock = null;
          updateWakeNote();
        }
      });
    } catch (error) {
      // The lock is still held. We just will not hear when it drops.
    }
    updateWakeNote();
  }).catch(function () {
    // Hidden tab, a denied request, or a browser that only looks supported.
  });
}

function releaseWakeLock() {
  var current = wakeLock;
  wakeRequest = wakeRequest + 1;
  wakeLock = null;
  releaseSentinel(current);
  updateWakeNote();
}

// "Screen stays on" while the lock is held. If this browser has no wake
// lock at all, say so in small type. A failed request stays quiet.
function updateWakeNote() {
  var note = document.getElementById("cook-wake");
  var text = "";
  var on = false;

  if (!note) {
    return;
  }

  if (!wakeLockSupported()) {
    text = "Screen may dim on this browser";
  } else if (wakeLock && !wakeLock.released) {
    text = "Screen stays on";
    on = true;
  }

  note.textContent = text;
  note.hidden = text === "";
  note.className = on ? "cook-wake is-on" : "cook-wake";
}

// The browser drops a wake lock when the page is hidden (lock the phone,
// switch apps). Ask again when this page is visible and we are still cooking.
function onVisibilityChange() {
  if (document.visibilityState !== "visible") {
    return;
  }
  if (screenFromHash() !== "cook") {
    return;
  }
  if (wakeLock && wakeLock.released) {
    wakeLock = null;
  }
  requestWakeLock();
}

// Hide the Recipes / Grocery list bar while cooking, and hold the wake
// lock only on that screen.
function syncCookingChrome(next) {
  var cooking = next === "cook";
  document.body.classList.toggle("is-cooking", cooking);
  if (cooking) {
    requestWakeLock();
    return;
  }
  releaseWakeLock();
  cookIngredientsOpen = false;
  cookIngredientsFor = "";
  cookSwipe = null;
}

function cookTopHtml(title, exitHref) {
  return (
    "<div class=\"cook-top\">" +
      "<p class=\"cook-title\">" + escapeHtml(title) + "</p>" +
      "<a class=\"cook-exit\" href=\"" + exitHref + "\">Exit</a>" +
    "</div>" +
    "<p class=\"cook-wake\" id=\"cook-wake\" role=\"status\" hidden></p>"
  );
}

function cookNavHtml(recipe, step, count) {
  var back;
  var next;

  if (step <= 1) {
    back = "<button type=\"button\" class=\"cook-back\" id=\"cook-back\" disabled>Back</button>";
  } else {
    back = "<a class=\"cook-back\" id=\"cook-back\" href=\"" + cookHref(recipe.id, step - 1) + "\">Back</a>";
  }

  if (step >= count) {
    next = "<a class=\"cook-next\" id=\"cook-next\" href=\"" + recipeHref(recipe.id) + "\">Done</a>";
  } else {
    next = "<a class=\"cook-next\" id=\"cook-next\" href=\"" + cookHref(recipe.id, step + 1) + "\">Next</a>";
  }

  return "<nav class=\"cook-nav\" aria-label=\"Steps\">" + back + next + "</nav>";
}

// Same rows as the recipe screen, at the serving count on screen.
// ingredientHtml / amountText do the formatting. This only lists them.
function cookIngredientsHtml(recipe) {
  var ingredients = recipe.ingredients || [];
  var scale;
  var list = "";
  var open;
  var i;

  if (!ingredients.length) {
    return "";
  }
  if (String(cookIngredientsFor) !== String(recipe.id)) {
    cookIngredientsOpen = false;
    cookIngredientsFor = String(recipe.id);
  }

  scale = scaleFor(recipe, chosenServings);
  for (i = 0; i < ingredients.length; i++) {
    list += ingredientHtml(ingredients[i], scale);
  }
  open = cookIngredientsOpen ? " open" : "";

  return (
    "<details class=\"cook-ingredients\" id=\"cook-ingredients\"" + open + ">" +
      "<summary>Ingredients <span class=\"cook-servings\">" +
        escapeHtml(servingsPhrase(chosenServings)) +
      "</span></summary>" +
      "<ul class=\"ingredients\">" + list + "</ul>" +
    "</details>"
  );
}

function cookScreenHtml(recipe, step) {
  var steps = recipe.steps || [];
  var text = steps[step - 1] || "";
  return (
    cookTopHtml(recipe.title, recipeHref(recipe.id)) +
    "<p class=\"cook-progress\" id=\"cook-progress\">Step " + step + " of " + steps.length + "</p>" +
    "<p class=\"cook-step\" id=\"cook-step\" tabindex=\"-1\">" + escapeHtml(text) + "</p>" +
    cookIngredientsHtml(recipe) +
    cookNavHtml(recipe, step, steps.length)
  );
}

function cookEmptyHtml(recipe) {
  return (
    cookTopHtml(recipe.title, recipeHref(recipe.id)) +
    "<p class=\"cook-step\" id=\"cook-step\" tabindex=\"-1\">This recipe has no steps.</p>"
  );
}

function cookMissingHtml() {
  return (
    cookTopHtml("Cooking", "#") +
    "<p class=\"cook-step\" id=\"cook-step\" tabindex=\"-1\">That recipe is not saved on this phone.</p>"
  );
}

function drawCook() {
  var cook = document.getElementById("cook");
  var target = cookTargetFromHash();
  var recipe = target ? findRecipe(target.id) : null;
  var existingPanel = document.getElementById("cook-ingredients");
  var steps;
  var step;
  var canonical;
  var stepEl;

  // Remember an open ingredients list before the screen is redrawn.
  if (existingPanel) {
    cookIngredientsOpen = !!existingPanel.open;
  }

  if (!recipe) {
    cook.innerHTML = cookMissingHtml();
    document.title = "Recipe not found";
    updateWakeNote();
    window.scrollTo(0, 0);
    return;
  }

  adoptServings(recipe);
  steps = recipe.steps || [];

  if (!steps.length) {
    cook.innerHTML = cookEmptyHtml(recipe);
    document.title = recipe.title;
    updateWakeNote();
    window.scrollTo(0, 0);
    return;
  }

  step = clampedStep(target.step, steps.length);
  canonical = cookHref(recipe.id, step);
  // A bad step number in the address is rewritten without a new history
  // entry, so Back does not return to the bad address.
  if (!hashesMatch(window.location.hash, canonical)) {
    history.replaceState(null, "", canonical);
  }

  cook.innerHTML = cookScreenHtml(recipe, step);
  document.title = recipe.title + " — Step " + step + " of " + steps.length;
  updateWakeNote();
  window.scrollTo(0, 0);

  stepEl = document.getElementById("cook-step");
  if (stepEl && stepEl.focus) {
    // Keep Exit and the title on screen. Focusing would otherwise scroll
    // the big step to the middle and hide the close button.
    try {
      stepEl.focus({ preventScroll: true });
    } catch (error) {
      stepEl.focus();
    }
  }
}

// delta is +1 for the next step and -1 for the previous one.
// On the last step, moving forward returns to the recipe (the Done button).
function shiftCookStep(delta) {
  var target = cookTargetFromHash();
  var recipe;
  var steps;
  var step;
  var next;

  if (!target) {
    return;
  }
  recipe = findRecipe(target.id);
  if (!recipe) {
    return;
  }
  steps = recipe.steps || [];
  if (!steps.length) {
    return;
  }
  step = clampedStep(target.step, steps.length);
  next = step + delta;
  if (next < 1) {
    return;
  }
  if (next > steps.length) {
    window.location.hash = recipeHref(recipe.id);
    return;
  }
  window.location.hash = cookHref(recipe.id, next);
}

// Buttons and links handle their own taps. A swipe that starts on one of
// them should not also change the step.
function isCookControl(node) {
  var tag;
  while (node && node !== document) {
    tag = node.tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || tag === "INPUT" || tag === "TEXTAREA" || tag === "LABEL") {
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

function onCookPointerDown(event) {
  if (screenFromHash() !== "cook") {
    return;
  }
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  if (cookSwipe) {
    return;
  }
  if (isCookControl(event.target)) {
    return;
  }
  cookSwipe = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY
  };
  if (event.currentTarget.setPointerCapture) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      // The pointer can end before we capture it. Back and Next still work.
    }
  }
}

function onCookPointerMove(event) {
  var dx;
  var dy;
  if (!cookSwipe || event.pointerId !== cookSwipe.id) {
    return;
  }
  dx = event.clientX - cookSwipe.x;
  dy = event.clientY - cookSwipe.y;
  // Once the finger is clearly moving sideways, don't let the page scroll
  // sideways or start a text selection.
  if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
    event.preventDefault();
  }
}

function onCookPointerUp(event) {
  var swipe = cookSwipe;
  var dx;
  var dy;

  if (!swipe || event.pointerId !== swipe.id) {
    return;
  }
  cookSwipe = null;
  dx = event.clientX - swipe.x;
  dy = event.clientY - swipe.y;

  // A short move, or a mostly vertical one, is a scroll, not a new step.
  // Moving toward the left turns to the next step.
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) {
    return;
  }
  if (dx < 0) {
    shiftCookStep(1);
  } else {
    shiftCookStep(-1);
  }
}

function onCookPointerCancel(event) {
  if (cookSwipe && event.pointerId === cookSwipe.id) {
    cookSwipe = null;
  }
}

function onCookToggle(event) {
  var panel = event.target;
  if (!panel || panel.id !== "cook-ingredients") {
    return;
  }
  // Replacing the panel removes the old one, which can fire toggle.
  // That removal is not the cook closing the list.
  if (!panel.isConnected) {
    return;
  }
  cookIngredientsOpen = !!panel.open;
}

// --- Add and edit --------------------------------------------------------
//
// #new is a blank form. #edit/<id> opens that recipe in the same form.
// Save writes one recipe into recipe-app.userRecipes and opens it.
// The seed file is not changed. Cancel is a link back, so nothing is written.
// Delete asks first. A deleted seed id is remembered, so the next visit
// does not bring that recipe back from the file. A deleted recipe you
// added is just dropped from the note.
//
// New ids start with "u-" plus the time. Seed ids are small numbers
// (1, 2, 3, ...), so the two kinds cannot clash.
//
// Amounts accept 1/2, 1 1/2, 0.5, or a blank box (stored as null, which
// the rest of the app already shows as "to taste"). The amount box stays
// on the full keyboard because a number keypad has no slash.

var FRACTION_GLYPHS = [
  ["⅛", "1/8"],
  ["¼", "1/4"],
  ["⅓", "1/3"],
  ["⅜", "3/8"],
  ["½", "1/2"],
  ["⅝", "5/8"],
  ["⅔", "2/3"],
  ["¾", "3/4"],
  ["⅞", "7/8"]
];

function normalizeAmountText(text) {
  var s = String(text).replace(/\u00a0/g, " ").replace(/\u2044/g, "/").replace(/\u2215/g, "/");
  var i;
  for (i = 0; i < FRACTION_GLYPHS.length; i++) {
    s = s.split(FRACTION_GLYPHS[i][0]).join(" " + FRACTION_GLYPHS[i][1]);
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.charAt(s.length - 1) === ".") {
    s = s.slice(0, -1);
  }
  return s;
}

function finishAmount(value) {
  if (!isFinite(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, amount: Math.round(value * 1000) / 1000 };
}

// Blank is valid and means "to taste" (amount null). Anything else has
// to be a number the cook can read: 0.5, 1/2, or 1 1/2.
function parseAmount(text) {
  var s = normalizeAmountText(text);
  var mixed;
  var frac;
  var whole;
  var numer;
  var denom;

  if (!s) {
    return { ok: true, amount: null };
  }

  mixed = /^([0-9]+)\s+([0-9]+)\s*\/\s*([0-9]+)$/.exec(s);
  if (mixed) {
    whole = parseInt(mixed[1], 10);
    numer = parseInt(mixed[2], 10);
    denom = parseInt(mixed[3], 10);
    if (!denom) {
      return { ok: false };
    }
    return finishAmount(whole + (numer / denom));
  }

  frac = /^([0-9]+)\s*\/\s*([0-9]+)$/.exec(s);
  if (frac) {
    numer = parseInt(frac[1], 10);
    denom = parseInt(frac[2], 10);
    if (!denom) {
      return { ok: false };
    }
    return finishAmount(numer / denom);
  }

  if (/^[0-9]+(\.[0-9]+)?$/.test(s) || /^\.[0-9]+$/.test(s)) {
    return finishAmount(Number(s));
  }
  return { ok: false };
}

// Show a stored amount in the form as 1/2 or 1 1/2 when it is one of
// the kitchen fractions. Other numbers stay decimals (2.75 stays 2.75
// only when it is not 2 3/4). Null stays a blank box.
function formatAmountForInput(amount) {
  var n;
  var thousandths;
  var whole;
  var remainder;
  var i;
  var numer;
  var denom;
  var target;
  var diff;
  var bestDiff;
  var bestNumer;
  var bestDenom;

  if (amount === null || typeof amount === "undefined" || amount === "") {
    return "";
  }
  n = Number(amount);
  if (!isFinite(n) || n < 0) {
    return "";
  }

  thousandths = Math.round(n * 1000);
  whole = Math.floor(thousandths / 1000);
  remainder = thousandths - whole * 1000;

  if (remainder === 0) {
    return String(whole);
  }
  if (1000 - remainder <= 10) {
    return String(whole + 1);
  }

  bestDiff = 11;
  bestNumer = 0;
  bestDenom = 1;
  for (i = 0; i < COOKING_FRACTIONS.length; i++) {
    numer = COOKING_FRACTIONS[i][0];
    denom = COOKING_FRACTIONS[i][1];
    target = Math.round((1000 * numer) / denom);
    diff = Math.abs(remainder - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestNumer = numer;
      bestDenom = denom;
    }
  }
  if (bestDiff <= 10 && bestNumer > 0) {
    if (whole === 0) {
      return bestNumer + "/" + bestDenom;
    }
    return whole + " " + bestNumer + "/" + bestDenom;
  }
  return String(thousandths / 1000);
}

function parseWholeNumber(text) {
  var s = String(text).trim();
  if (!/^[0-9]+$/.test(s)) {
    return null;
  }
  return parseInt(s, 10);
}

function parseOptionalMinutes(text) {
  var s = String(text).trim();
  var n;
  if (!s) {
    return { ok: true, minutes: null };
  }
  if (!/^[0-9]+$/.test(s)) {
    return { ok: false };
  }
  n = parseInt(s, 10);
  if (n < 1) {
    return { ok: false };
  }
  return { ok: true, minutes: n };
}

function parseTags(text) {
  var parts = String(text).split(",");
  var tags = [];
  var i;
  var tag;
  for (i = 0; i < parts.length; i++) {
    tag = parts[i].trim();
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
}

function idTaken(id) {
  var wanted = String(id);
  var i;
  for (i = 0; i < seedRecipes.length; i++) {
    if (seedRecipes[i] && String(seedRecipes[i].id) === wanted) {
      return true;
    }
  }
  if (userState && Array.isArray(userState.recipes)) {
    for (i = 0; i < userState.recipes.length; i++) {
      if (userState.recipes[i] && String(userState.recipes[i].id) === wanted) {
        return true;
      }
    }
  }
  return false;
}

function newRecipeId() {
  var i;
  var id;
  for (i = 0; i < 6; i++) {
    id = "u-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    if (!idTaken(id)) {
      return id;
    }
  }
  return "u-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

function stateWithRecipe(recipe) {
  var nextRecipes = [];
  var nextDeleted = [];
  var wanted = String(recipe.id);
  var replaced = false;
  var i;

  for (i = 0; i < userState.recipes.length; i++) {
    if (String(userState.recipes[i].id) === wanted) {
      if (!replaced) {
        nextRecipes.push(recipe);
        replaced = true;
      }
    } else {
      nextRecipes.push(userState.recipes[i]);
    }
  }
  if (!replaced) {
    nextRecipes.push(recipe);
  }
  for (i = 0; i < userState.deletedIds.length; i++) {
    if (String(userState.deletedIds[i]) !== wanted) {
      nextDeleted.push(userState.deletedIds[i]);
    }
  }
  return { recipes: nextRecipes, deletedIds: nextDeleted };
}

function stateWithoutRecipe(id) {
  var wanted = String(id);
  var nextRecipes = [];
  var nextDeleted = [];
  var isSeed = false;
  var already = false;
  var i;

  for (i = 0; i < userState.recipes.length; i++) {
    if (String(userState.recipes[i].id) !== wanted) {
      nextRecipes.push(userState.recipes[i]);
    }
  }
  for (i = 0; i < userState.deletedIds.length; i++) {
    nextDeleted.push(String(userState.deletedIds[i]));
    if (String(userState.deletedIds[i]) === wanted) {
      already = true;
    }
  }
  for (i = 0; i < seedRecipes.length; i++) {
    if (String(seedRecipes[i].id) === wanted) {
      isSeed = true;
    }
  }
  // Only seed ids are remembered as deleted. A recipe you added is
  // simply removed. Remembering it would hide a future seed recipe
  // that happened to reuse that id, and our own ids already cannot.
  if (isSeed && !already) {
    nextDeleted.push(wanted);
  }
  return { recipes: nextRecipes, deletedIds: nextDeleted };
}

// Start from the saved recipe so source, cuisine, and protein stay
// when the form does not ask for them. Then replace the fields it does.
function recipeFromFields(existing, fields) {
  var recipe = existing ? JSON.parse(JSON.stringify(existing)) : {};
  if (!existing) {
    recipe.id = newRecipeId();
  }
  recipe.title = fields.title;
  recipe.servings = fields.servings;
  if (fields.minutes === null) {
    delete recipe.total_minutes;
  } else {
    recipe.total_minutes = fields.minutes;
  }
  recipe.tags = fields.tags;
  recipe.ingredients = fields.ingredients;
  recipe.steps = fields.steps;
  return recipe;
}

function fieldErrorHtml(name) {
  return "<span class=\"field-error\" data-error=\"" + name + "\" aria-live=\"polite\" hidden></span>";
}

function ingredientRowHtml(ingredient) {
  var amount = formatAmountForInput(ingredient ? ingredient.amount : null);
  var unit = ingredient && ingredient.unit ? ingredient.unit : "";
  var name = ingredient && ingredient.name ? ingredient.name : "";
  var prep = ingredient && ingredient.prep ? ingredient.prep : "";
  return (
    "<div class=\"editor-row\" data-ingredient-row>" +
      "<div class=\"editor-grid\">" +
        "<label class=\"field\">" +
          "<span class=\"field-label\">Amount</span>" +
          "<input type=\"text\" inputmode=\"text\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" enterkeyhint=\"next\" placeholder=\"1/2\" data-amount value=\"" + escapeHtml(amount) + "\">" +
          fieldErrorHtml("amount") +
        "</label>" +
        "<label class=\"field\">" +
          "<span class=\"field-label\">Unit</span>" +
          "<input type=\"text\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" enterkeyhint=\"next\" placeholder=\"tbsp\" data-unit value=\"" + escapeHtml(unit) + "\">" +
        "</label>" +
        "<label class=\"field span-2\">" +
          "<span class=\"field-label\">Name</span>" +
          "<input type=\"text\" autocomplete=\"off\" autocapitalize=\"words\" enterkeyhint=\"next\" placeholder=\"garlic\" data-name value=\"" + escapeHtml(name) + "\">" +
          fieldErrorHtml("name") +
        "</label>" +
        "<label class=\"field span-2\">" +
          "<span class=\"field-label\">Prep (optional)</span>" +
          "<input type=\"text\" autocomplete=\"off\" autocapitalize=\"sentences\" enterkeyhint=\"next\" placeholder=\"diced\" data-prep value=\"" + escapeHtml(prep) + "\">" +
        "</label>" +
      "</div>" +
      "<button type=\"button\" class=\"secondary remove-row\" data-remove=\"ingredient\" aria-label=\"Remove ingredient\">Remove</button>" +
    "</div>"
  );
}

function stepRowHtml(text) {
  return (
    "<div class=\"editor-row\" data-step-row>" +
      "<label class=\"field\">" +
        "<span class=\"field-label\">Step</span>" +
        "<textarea rows=\"4\" data-step autocomplete=\"off\" autocapitalize=\"sentences\" enterkeyhint=\"next\">" + escapeHtml(text || "") + "</textarea>" +
      "</label>" +
      "<button type=\"button\" class=\"secondary remove-row\" data-remove=\"step\" aria-label=\"Remove step\">Remove</button>" +
    "</div>"
  );
}

function editorFormHtml(recipe) {
  var isEdit = !!recipe;
  var ingredients = recipe && recipe.ingredients && recipe.ingredients.length ? recipe.ingredients : [null];
  var steps = recipe && recipe.steps && recipe.steps.length ? recipe.steps : [""];
  var ingredientHtml = "";
  var stepHtml = "";
  var i;
  var title = "";
  var servings = "";
  var minutes = "";
  var tags = "";
  var cancel;
  var deleteBlock = "";

  if (recipe) {
    title = recipe.title || "";
    if (recipe.servings) {
      servings = String(recipe.servings);
    }
    if (recipe.total_minutes) {
      minutes = String(recipe.total_minutes);
    }
    if (recipe.tags && recipe.tags.length) {
      tags = recipe.tags.join(", ");
    }
  }

  for (i = 0; i < ingredients.length; i++) {
    ingredientHtml += ingredientRowHtml(ingredients[i]);
  }
  for (i = 0; i < steps.length; i++) {
    stepHtml += stepRowHtml(steps[i]);
  }

  cancel = isEdit ? recipeHref(recipe.id) : "#";

  if (isEdit) {
    deleteBlock =
      "<div class=\"delete-box\" id=\"delete-box\">" +
        "<button type=\"button\" class=\"secondary\" id=\"delete-recipe\">Delete</button>" +
        "<div class=\"offer\" id=\"delete-confirm\" hidden>" +
          "<p>Delete this recipe? It will be removed from this phone. Anything already on your grocery list stays.</p>" +
          "<button type=\"button\" class=\"add-grocery\" id=\"delete-yes\">Delete</button>" +
          "<button type=\"button\" class=\"secondary\" id=\"delete-no\">Keep recipe</button>" +
        "</div>" +
      "</div>";
  }

  return (
    "<form id=\"recipe-form\" autocomplete=\"off\" novalidate>" +
      "<p class=\"kicker\">Manolo's kitchen</p>" +
      "<h1>" + (isEdit ? "Edit recipe" : "New recipe") + "</h1>" +
      "<label class=\"field\">" +
        "<span class=\"field-label\">Title</span>" +
        "<input id=\"recipe-title\" name=\"title\" type=\"text\" autocomplete=\"off\" autocapitalize=\"words\" enterkeyhint=\"next\" value=\"" + escapeHtml(title) + "\">" +
        fieldErrorHtml("title") +
      "</label>" +
      "<label class=\"field\">" +
        "<span class=\"field-label\">Servings</span>" +
        "<input id=\"recipe-servings\" name=\"servings\" type=\"text\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" enterkeyhint=\"next\" value=\"" + escapeHtml(servings) + "\">" +
        fieldErrorHtml("servings") +
      "</label>" +
      "<label class=\"field\">" +
        "<span class=\"field-label\">Total minutes (optional)</span>" +
        "<input id=\"recipe-minutes\" name=\"minutes\" type=\"text\" inputmode=\"numeric\" pattern=\"[0-9]*\" autocomplete=\"off\" enterkeyhint=\"next\" value=\"" + escapeHtml(minutes) + "\">" +
        fieldErrorHtml("minutes") +
      "</label>" +
      "<label class=\"field\">" +
        "<span class=\"field-label\">Tags (optional)</span>" +
        "<input id=\"recipe-tags\" name=\"tags\" type=\"text\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" enterkeyhint=\"next\" placeholder=\"weeknight, gluten-free\" value=\"" + escapeHtml(tags) + "\">" +
        "<span class=\"hint\">Separate tags with commas.</span>" +
      "</label>" +
      "<h2>Ingredients</h2>" +
      "<p class=\"hint\">Amount can be 1/2, 1 1/2, 0.5, or blank for to taste.</p>" +
      "<div class=\"editor-rows\" id=\"ingredient-rows\">" + ingredientHtml + "</div>" +
      "<p class=\"field-error\" data-error=\"ingredients\" aria-live=\"polite\" hidden></p>" +
      "<button type=\"button\" class=\"secondary\" id=\"add-ingredient\">Add ingredient</button>" +
      "<h2>Steps</h2>" +
      "<div class=\"editor-rows\" id=\"step-rows\">" + stepHtml + "</div>" +
      "<p class=\"field-error\" data-error=\"steps\" aria-live=\"polite\" hidden></p>" +
      "<button type=\"button\" class=\"secondary\" id=\"add-step\">Add step</button>" +
      "<p class=\"field-error\" data-error=\"save\" aria-live=\"polite\" hidden></p>" +
      "<button type=\"submit\" class=\"add-grocery\" id=\"save-recipe\">Save</button>" +
      "<a class=\"secondary\" href=\"" + cancel + "\">Cancel</a>" +
      deleteBlock +
    "</form>"
  );
}

function missingEditHtml() {
  return (
    "<a class=\"back\" href=\"#\">← Back to recipes</a>" +
    "<h1>Recipe not found</h1>" +
    "<p>That recipe is not saved on this phone.</p>"
  );
}

function loadErrorEditorHtml() {
  return (
    "<a class=\"back\" href=\"#\">← Back to recipes</a>" +
    "<h1>Recipes could not be loaded</h1>" +
    "<p>The form needs the recipe file. Open this site from GitHub Pages, or run a local web server in this folder, then refresh.</p>"
  );
}

function drawEditor() {
  var editor = document.getElementById("editor");
  var id;
  var recipe;
  var titleInput;

  if (loadFailed) {
    editor.innerHTML = loadErrorEditorHtml();
    document.title = "Recipes";
    window.scrollTo(0, 0);
    return;
  }

  if (isNewHash()) {
    editor.innerHTML = editorFormHtml(null);
    document.title = "New recipe";
    window.scrollTo(0, 0);
    titleInput = document.getElementById("recipe-title");
    if (titleInput) {
      titleInput.focus();
    }
    return;
  }

  id = editIdFromHash();
  recipe = id ? findRecipe(id) : null;
  if (!recipe) {
    editor.innerHTML = missingEditHtml();
    document.title = "Recipe not found";
    window.scrollTo(0, 0);
    return;
  }

  editor.innerHTML = editorFormHtml(recipe);
  document.title = "Edit recipe";
  window.scrollTo(0, 0);
}

function clearFormErrors(form) {
  var errors = form.querySelectorAll(".field-error");
  var inputs = form.querySelectorAll("[aria-invalid]");
  var i;
  for (i = 0; i < errors.length; i++) {
    errors[i].hidden = true;
    errors[i].textContent = "";
  }
  for (i = 0; i < inputs.length; i++) {
    inputs[i].removeAttribute("aria-invalid");
  }
}

function showFormError(scope, input, key, message) {
  var el = scope.querySelector("[data-error=\"" + key + "\"]");
  if (el) {
    el.hidden = false;
    el.textContent = message;
  }
  if (input) {
    input.setAttribute("aria-invalid", "true");
  }
  return input || el;
}

// Read the form. Blank ingredient rows and blank steps are ignored.
// A row you started has to have a name, and the amount has to be blank
// or a number we understand. Returns the fields, or null if something
// needs fixing. Messages sit under the fields they belong to.
function readEditorFields() {
  var form = document.getElementById("recipe-form");
  var titleInput = document.getElementById("recipe-title");
  var servingsInput = document.getElementById("recipe-servings");
  var minutesInput = document.getElementById("recipe-minutes");
  var tagsInput = document.getElementById("recipe-tags");
  var title;
  var servings;
  var minutes;
  var rows;
  var steps;
  var ingredients = [];
  var stepValues = [];
  var anyIngredient = false;
  var i;
  var row;
  var amountInput;
  var nameInput;
  var unitInput;
  var prepInput;
  var name;
  var unit;
  var prep;
  var parsed;
  var blank;
  var stepInput;
  var stepText;
  var firstBad = null;
  var mark;

  if (!form) {
    return null;
  }
  clearFormErrors(form);

  title = titleInput.value.trim();
  if (!title) {
    mark = showFormError(form, titleInput, "title", "Give this recipe a title.");
    if (!firstBad) {
      firstBad = mark;
    }
  }

  servings = parseWholeNumber(servingsInput.value);
  if (servings === null || servings < 1) {
    mark = showFormError(form, servingsInput, "servings", "Servings needs to be a whole number, at least 1.");
    if (!firstBad) {
      firstBad = mark;
    }
  }

  minutes = parseOptionalMinutes(minutesInput.value);
  if (!minutes.ok) {
    mark = showFormError(form, minutesInput, "minutes", "Use minutes as a whole number, 1 or more, or leave this blank.");
    if (!firstBad) {
      firstBad = mark;
    }
  }

  rows = form.querySelectorAll("[data-ingredient-row]");
  for (i = 0; i < rows.length; i++) {
    row = rows[i];
    amountInput = row.querySelector("[data-amount]");
    nameInput = row.querySelector("[data-name]");
    unitInput = row.querySelector("[data-unit]");
    prepInput = row.querySelector("[data-prep]");
    name = nameInput.value.trim();
    unit = unitInput.value.trim();
    prep = prepInput.value.trim();
    parsed = parseAmount(amountInput.value);
    blank = !String(amountInput.value).trim() && !name && !unit && !prep;
    if (blank) {
      continue;
    }
    anyIngredient = true;
    if (!parsed.ok) {
      mark = showFormError(row, amountInput, "amount", "Use an amount like 1/2, 1 1/2, or 0.5, or leave it blank.");
      if (!firstBad) {
        firstBad = mark;
      }
    }
    if (!name) {
      mark = showFormError(row, nameInput, "name", "Name this ingredient.");
      if (!firstBad) {
        firstBad = mark;
      }
    }
    if (parsed.ok && name) {
      ingredients.push({
        name: name,
        amount: parsed.amount,
        unit: unit,
        prep: prep
      });
    }
  }

  if (!anyIngredient) {
    mark = showFormError(form, null, "ingredients", "Add at least one ingredient.");
    if (!firstBad) {
      firstBad = mark;
    }
  }

  steps = form.querySelectorAll("[data-step-row]");
  for (i = 0; i < steps.length; i++) {
    stepInput = steps[i].querySelector("[data-step]");
    stepText = stepInput.value.trim();
    if (!stepText) {
      continue;
    }
    stepValues.push(stepText);
  }
  if (stepValues.length === 0) {
    mark = showFormError(form, null, "steps", "Add at least one step.");
    if (!firstBad) {
      firstBad = mark;
    }
  }

  if (firstBad) {
    if (firstBad.scrollIntoView) {
      firstBad.scrollIntoView(true);
    }
    return null;
  }

  return {
    title: title,
    servings: servings,
    minutes: minutes.minutes,
    tags: parseTags(tagsInput.value),
    ingredients: ingredients,
    steps: stepValues
  };
}

function showSaveError(message) {
  var el = document.querySelector("#recipe-form [data-error=\"save\"]");
  if (!el) {
    return;
  }
  el.hidden = false;
  el.textContent = message;
  if (el.scrollIntoView) {
    el.scrollIntoView(true);
  }
}

function openHash(hash) {
  try {
    history.replaceState(null, "", hash);
  } catch (error) {
    window.location.hash = hash;
    return;
  }
  showFromHash();
}

function saveEditorForm() {
  var existing = null;
  var id = editIdFromHash();
  var fields;
  var recipe;

  if (loadFailed) {
    return;
  }
  if (id) {
    existing = findRecipe(id);
    if (!existing) {
      return;
    }
  }

  fields = readEditorFields();
  if (!fields) {
    return;
  }

  recipe = recipeFromFields(existing, fields);
  if (!writeUserState(stateWithRecipe(recipe))) {
    showSaveError("This phone could not save the recipe. Check that storage is allowed for this site, then try again.");
    return;
  }
  renderList();
  openHash(recipeHref(recipe.id));
}

function deleteEditorRecipe() {
  var id = editIdFromHash();
  if (!id || !findRecipe(id)) {
    return;
  }
  if (!writeUserState(stateWithoutRecipe(id))) {
    showSaveError("This phone could not delete the recipe. Check that storage is allowed for this site, then try again.");
    return;
  }
  renderList();
  openHash("#");
}

function addIngredientRow() {
  var host = document.getElementById("ingredient-rows");
  var rows;
  var input;
  if (!host) {
    return;
  }
  host.insertAdjacentHTML("beforeend", ingredientRowHtml(null));
  rows = host.querySelectorAll("[data-amount]");
  input = rows[rows.length - 1];
  if (input) {
    input.focus();
  }
}

function addStepRow() {
  var host = document.getElementById("step-rows");
  var rows;
  var input;
  if (!host) {
    return;
  }
  host.insertAdjacentHTML("beforeend", stepRowHtml(""));
  rows = host.querySelectorAll("[data-step]");
  input = rows[rows.length - 1];
  if (input) {
    input.focus();
  }
}

function showDeleteConfirm() {
  var button = document.getElementById("delete-recipe");
  var box = document.getElementById("delete-confirm");
  var yes;
  if (button) {
    button.hidden = true;
  }
  if (box) {
    box.hidden = false;
    yes = document.getElementById("delete-yes");
    if (yes) {
      yes.focus();
    }
  }
}

function hideDeleteConfirm() {
  var button = document.getElementById("delete-recipe");
  var box = document.getElementById("delete-confirm");
  if (box) {
    box.hidden = true;
  }
  if (button) {
    button.hidden = false;
    button.focus();
  }
}

function rowFromButton(button, attr) {
  var node = button;
  while (node && node !== document) {
    if (node.getAttribute && node.getAttribute(attr) !== null) {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

function onEditorClick(event) {
  var button = clickedButton(event);
  var row;
  if (!button) {
    return;
  }
  if (button.id === "add-ingredient") {
    addIngredientRow();
    return;
  }
  if (button.id === "add-step") {
    addStepRow();
    return;
  }
  if (button.id === "delete-recipe") {
    showDeleteConfirm();
    return;
  }
  if (button.id === "delete-no") {
    hideDeleteConfirm();
    return;
  }
  if (button.id === "delete-yes") {
    deleteEditorRecipe();
    return;
  }
  if (button.getAttribute("data-remove") === "ingredient") {
    row = rowFromButton(button, "data-ingredient-row");
    if (row && row.parentNode) {
      row.parentNode.removeChild(row);
    }
    return;
  }
  if (button.getAttribute("data-remove") === "step") {
    row = rowFromButton(button, "data-step-row");
    if (row && row.parentNode) {
      row.parentNode.removeChild(row);
    }
  }
}

function onEditorSubmit(event) {
  event.preventDefault();
  saveEditorForm();
}

// Clear the message under the field being edited, so a fixed row does
// not keep showing the old complaint.
function classListHas(node, name) {
  var parts;
  var i;
  if (!node || !node.className) {
    return false;
  }
  parts = String(node.className).split(/\s+/);
  for (i = 0; i < parts.length; i++) {
    if (parts[i] === name) {
      return true;
    }
  }
  return false;
}

function onEditorInput(event) {
  var node = event.target;
  var field = node ? node.parentNode : null;
  var errorEl = null;
  var sectionError = null;
  // Walk up from the input so we clear that field's message and, when
  // the field sits in a row, the "add at least one" message too.
  while (field && field !== document) {
    if (!errorEl && classListHas(field, "field") && field.querySelector) {
      errorEl = field.querySelector(".field-error");
    }
    if (field.getAttribute && field.getAttribute("data-ingredient-row") !== null) {
      sectionError = document.querySelector("#recipe-form [data-error=\"ingredients\"]");
    }
    if (field.getAttribute && field.getAttribute("data-step-row") !== null) {
      sectionError = document.querySelector("#recipe-form [data-error=\"steps\"]");
    }
    field = field.parentNode;
  }
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (sectionError) {
    sectionError.hidden = true;
    sectionError.textContent = "";
  }
  if (node && node.removeAttribute) {
    node.removeAttribute("aria-invalid");
  }
}

// --- Start ---------------------------------------------------------------

// The script tag is at the bottom of index.html, so the elements exist.
async function start() {
  document.getElementById("search").addEventListener("input", function () {
    if (ready) {
      renderList();
    }
  });

  window.addEventListener("hashchange", function () {
    // Home and the grocery list work even if the recipe file failed to
    // load. A recipe, the form, or cooking waits until the recipes are
    // ready, so we don't flash "Recipe not found" during that load.
    var screen = screenFromHash();
    if (ready || loadFailed || (screen !== "recipe" && screen !== "cook" && screen !== "editor")) {
      showFromHash();
    }
  });

  document.addEventListener("visibilitychange", onVisibilityChange);

  // One listener for the life of the page. The buttons are redrawn each
  // time the count changes, and this still hears the taps.
  document.getElementById("detail").addEventListener("click", onDetailClick);
  document.getElementById("grocery").addEventListener("click", onGroceryClick);

  // The form is redrawn when you open it. These listeners stay on the
  // section, so they still hear Save, Add ingredient, and Delete.
  var editorEl = document.getElementById("editor");
  editorEl.addEventListener("click", onEditorClick);
  editorEl.addEventListener("submit", onEditorSubmit);
  editorEl.addEventListener("input", onEditorInput);

  // Swipes are heard on the cooking section, which stays in the page
  // while its contents are redrawn for each step. pointermove is not
  // passive so a sideways swipe can cancel scrolling.
  var cookEl = document.getElementById("cook");
  cookEl.addEventListener("pointerdown", onCookPointerDown);
  cookEl.addEventListener("pointermove", onCookPointerMove, { passive: false });
  cookEl.addEventListener("pointerup", onCookPointerUp);
  cookEl.addEventListener("pointercancel", onCookPointerCancel);
  // toggle does not bubble. The capture listener still hears it.
  cookEl.addEventListener("toggle", onCookToggle, true);

  // Tapping Recipes while you are already there should not jump to the top.
  document.getElementById("tab-recipes").addEventListener("click", function (event) {
    if (screenFromHash() === "home") {
      event.preventDefault();
    }
  });

  // The grocery list does not need the recipe file. Load it first so the
  // bottom bar can show the count even while recipes are still loading.
  grocery = readGrocery();
  updateNav();

  try {
    recipes = await loadRecipes();
  } catch (error) {
    showLoadError();
    // The saved grocery list can still open if the address is #list.
    // The form explains that it cannot open when the book failed to load.
    if (screenFromHash() === "list" || screenFromHash() === "editor") {
      showFromHash();
    }
    return;
  }

  ready = true;
  renderList();
  showFromHash();
}

start();
