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

  The address hash is the part after the # sign. Changing it does not
  reload the page, and the phone's Back button walks back through those
  changes. Example: #recipe/5 is "Baked shrimp fra diavolo".

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
// screen. Opening a recipe (or coming back to it) starts again at the
// number written in the recipe. Nothing here is written to localStorage.
var chosenServings = 0;

// The − button stops at 1. The + button stops at 24, enough for a crowd
// and not so high that the amounts become nonsense.
var MIN_SERVINGS = 1;
var MAX_SERVINGS = 24;

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
    "<h2>Ingredients</h2>" +
    "<ul class=\"ingredients\">" + ingredientList + "</ul>" +
    "<h2>Steps</h2>" +
    stepList
  );
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

// "#recipe/5" -> "5". Anything else means the home screen.
function recipeIdFromHash() {
  var match = /^#recipe\/([^/]+)$/.exec(window.location.hash);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function showFromHash() {
  var home = document.getElementById("home");
  var detail = document.getElementById("detail");
  var id = recipeIdFromHash();

  if (!id) {
    var y = listScrollY;
    detail.hidden = true;
    detail.innerHTML = "";
    home.hidden = false;
    document.title = "Recipes";
    window.scrollTo(0, y);
    return;
  }

  // Remember the list position only when we are actually leaving it.
  if (!home.hidden) {
    listScrollY = window.scrollY;
  }

  home.hidden = true;
  detail.hidden = false;
  window.scrollTo(0, 0);

  var recipe = findRecipe(id);
  if (!recipe) {
    chosenServings = 0;
    detail.innerHTML = missingRecipeHtml();
    document.title = "Recipe not found";
    return;
  }

  // Every open starts at the recipe's own servings. A count chosen last
  // time is forgotten on purpose: scaling is only for this look at the page.
  chosenServings = recipe.servings;
  if (chosenServings < MIN_SERVINGS) {
    chosenServings = MIN_SERVINGS;
  }
  if (chosenServings > MAX_SERVINGS) {
    chosenServings = MAX_SERVINGS;
  }
  drawDetail(recipe);
}

// Redraw the open recipe at chosenServings. Reads the recipe, does not write it.
function drawDetail(recipe) {
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
    if (ready) {
      showFromHash();
    }
  });

  // One listener for the life of the page. The buttons are redrawn each
  // time the count changes, and this still hears the taps.
  document.getElementById("detail").addEventListener("click", onDetailClick);

  try {
    recipes = await loadRecipes();
  } catch (error) {
    showLoadError();
    return;
  }

  ready = true;
  renderList();
  showFromHash();
}

start();
