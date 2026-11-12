/*
  Manolo's recipe book.

  What this file does, in order:
    1. Load the recipes (from the phone if we already saved them,
       otherwise from data/recipes.json).
    2. Draw a card for each recipe, and filter that list as you type.
    3. Open one recipe when the address ends with #recipe/<id>.
    4. On that recipe, − and + change how many people you are cooking for.
       Ingredient amounts on the screen scale to match. The saved recipe
       is never edited.
    5. Add those scaled ingredients to a grocery list (#list). The same
       ingredient from two recipes becomes one line. The list is saved
       on the phone, in its own note, separate from the recipes.
    6. Start cooking opens one step at a time (#cook/<id>/<step>, step
       numbers start at 1). Back, Next, and a sideways swipe move between
       steps. The screen stays awake while that page is open, when the
       phone allows it.

  The address hash is the part after the # sign. Changing it does not
  reload the page, and the phone's Back button walks back through those
  changes. Example: #recipe/5 is "Baked shrimp fra diavolo". #cook/5/2
  is step 2 of that recipe. #list is the grocery list.

  There is no framework and no build step. This script is plain JavaScript
  that the browser runs from the <script> tag at the bottom of index.html.
*/

// The list currently saved on this phone. Empty until loading finishes.
var recipes = [];

// True after the list is ready. Stops search from running too early.
var ready = false;

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
var RECIPES_KEY = "recipe-app.recipes";
var VERSION_KEY = "recipe-app.data-version";

// A different key from the recipes, so clearing the grocery list
// never deletes the recipe book. Same "recipe-app." prefix so it
// will not collide with another project on this GitHub Pages host.
var GROCERY_KEY = "recipe-app.grocery";

// Which edition of data/recipes.json we last copied onto the phone.
// After you edit the seed file and want every phone to pick up the new
// copy, change this to "2", then "3", and so on.
var DATA_VERSION = "1";

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
function metaLine(recipe) {
  var bits = [minutesLabel(recipe.total_minutes)];
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

// Returns the saved list, or null if this phone has no current copy.
function readSavedRecipes() {
  if (storageGet(VERSION_KEY) !== DATA_VERSION) {
    return null;
  }
  var raw = storageGet(RECIPES_KEY);
  if (!raw) {
    return null;
  }
  try {
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

// Save the list first, then the version. If we saved the version first and
// the list failed, the next visit would trust an empty notebook.
function writeSavedRecipes(list) {
  if (!storageSet(RECIPES_KEY, JSON.stringify(list))) {
    return false;
  }
  return storageSet(VERSION_KEY, DATA_VERSION);
}

// First visit (or a raised DATA_VERSION): copy data/recipes.json into
// localStorage. Every visit after that reads localStorage and leaves the
// file alone, so the book still opens when the phone is offline.
async function loadRecipes() {
  var saved = readSavedRecipes();
  if (saved) {
    return saved;
  }

  // Relative path, so it works in the GitHub Pages subfolder.
  var response = await fetch("data/recipes.json");
  if (!response.ok) {
    throw new Error("Could not load data/recipes.json");
  }
  var fresh = await response.json();
  if (!Array.isArray(fresh)) {
    throw new Error("Recipe file was not a list");
  }
  writeSavedRecipes(fresh);
  return fresh;
}

function showLoadError() {
  var list = document.getElementById("list");
  list.innerHTML = "";
  var message = document.createElement("p");
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
  var href = "#recipe/" + encodeURIComponent(recipe.id);
  return (
    "<a class=\"card\" href=\"" + href + "\">" +
      "<h2>" + escapeHtml(recipe.title) + "</h2>" +
      "<p class=\"meta\">" + escapeHtml(metaLine(recipe)) + "</p>" +
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
    count.hidden = true;
    return;
  }

  empty.hidden = true;

  if (found.length === 0) {
    count.hidden = true;
    list.innerHTML = "";
    return;
  }

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

  // href="#" clears the recipe id, which shows the list again.
  // Opening a card already pushed a history entry, so the phone Back
  // button returns to the list even if you never tap this one.
  return (
    "<a class=\"back\" href=\"#\">← Back to recipes</a>" +
    "<h1>" + escapeHtml(recipe.title) + "</h1>" +
    "<p class=\"meta\">" + escapeHtml(metaLine(recipe)) + "</p>" +
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
// "#cook/5/2" is cooking. Anything else, including no hash, is home.
function screenFromHash() {
  if (window.location.hash === "#list") {
    return "list";
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

  // Home and the grocery list forget the serving count. The next open
  // of a recipe starts from the number written in that recipe.
  if (next !== "recipe" && next !== "cook") {
    servingsForId = "";
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
    // load. A recipe or cooking screen waits until the recipes are ready,
    // so we don't flash "Recipe not found" during that load.
    var screen = screenFromHash();
    if (ready || (screen !== "recipe" && screen !== "cook")) {
      showFromHash();
    }
  });

  document.addEventListener("visibilitychange", onVisibilityChange);

  // One listener for the life of the page. The buttons are redrawn each
  // time the count changes, and this still hears the taps.
  document.getElementById("detail").addEventListener("click", onDetailClick);
  document.getElementById("grocery").addEventListener("click", onGroceryClick);

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
    if (screenFromHash() === "list") {
      showFromHash();
    }
    return;
  }

  ready = true;
  renderList();
  showFromHash();
}

start();
