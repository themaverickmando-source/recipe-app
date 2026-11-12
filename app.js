/*
  Manolo's recipe book, step 1.

  What this file does, in order:
    1. Load the recipes (from the phone if we already saved them,
       otherwise from data/recipes.json).
    2. Draw a card for each recipe, and filter that list as you type.
    3. Open one recipe when the address ends with #recipe/<id>.

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

function servingsLabel(count) {
  if (count === 1) {
    return "Serves 1";
  }
  return "Serves " + count;
}

function minutesLabel(count) {
  if (count === 1) {
    return "1 minute";
  }
  return count + " minutes";
}

// One line of facts. The card leaves servings off; the recipe screen includes them.
function metaLine(recipe, includeServings) {
  var bits = [];
  if (includeServings) {
    bits.push(servingsLabel(recipe.servings));
  }
  bits.push(minutesLabel(recipe.total_minutes));
  if (recipe.cuisine) {
    bits.push(recipe.cuisine);
  }
  if (recipe.protein) {
    bits.push(recipe.protein);
  }
  return bits.join(" · ");
}

// amount is null for "to taste" items (lemon, parmesan, a handful of herbs).
// unit is printed as stored, including package sizes such as "28-oz cans".
function amountText(ingredient) {
  if (ingredient.amount === null || typeof ingredient.amount === "undefined") {
    return "to taste";
  }
  var text = String(ingredient.amount);
  if (ingredient.unit) {
    text += " " + ingredient.unit;
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
      "<p class=\"meta\">" + escapeHtml(metaLine(recipe, false)) + "</p>" +
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

function ingredientHtml(ingredient) {
  var prep = ingredient.prep
    ? "<span class=\"prep\">" + escapeHtml(ingredient.prep) + "</span>"
    : "";
  return (
    "<li>" +
      "<strong class=\"amount\">" + escapeHtml(amountText(ingredient)) + "</strong> " +
      escapeHtml(ingredient.name) +
      prep +
    "</li>"
  );
}

function recipeDetailHtml(recipe) {
  var ingredients = recipe.ingredients || [];
  var steps = recipe.steps || [];
  var ingredientList = "";
  var stepList = "<ol class=\"steps\">";
  var i;

  for (i = 0; i < ingredients.length; i++) {
    ingredientList += ingredientHtml(ingredients[i]);
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
    "<p class=\"meta\">" + escapeHtml(metaLine(recipe, true)) + "</p>" +
    source +
    tagsHtml(recipe.tags) +
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
    detail.innerHTML = missingRecipeHtml();
    document.title = "Recipe not found";
    return;
  }

  detail.innerHTML = recipeDetailHtml(recipe);
  document.title = recipe.title;
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
