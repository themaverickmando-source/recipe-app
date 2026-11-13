# Manolo's recipes

A recipe book that opens in the phone browser. Plain HTML, CSS, and JavaScript. No build step and no frameworks.

Meant to be published with GitHub Pages from the `main` branch, root folder:

https://themaverickmando-source.github.io/recipe-app/

## What you will see

- A search box and a card for each recipe.
- Tap a card to open the recipe. The address becomes `#recipe/` plus that recipe's id.
- The phone Back button returns to the list. There is also a **Back to recipes** button.
- **−** and **+** change the serving count. Ingredient amounts on the screen change with it. The saved recipe does not.
- **Add to grocery list** saves those amounts. If that recipe is already on the list, the app asks before it updates the old line.
- The bottom bar opens the **Grocery list** (the address becomes `#list`). The same ingredient from two recipes becomes one line when the name and the unit match. Tap a line to check it off.
- **Start cooking** opens one step at a time. The address becomes `#cook/` plus the recipe id and the step number (`#cook/5/2` is step 2). **Back** and **Next** sit at the bottom, and a sideways swipe does the same thing. On the last step, **Next** says **Done** and returns to the recipe. **Exit** does too. The screen tries to stay on while that page is open. A collapsible **Ingredients** list uses the serving count you picked on the recipe.
- **Add recipe** (on the list) opens a form. The address becomes `#new`. **Edit** on a recipe opens `#edit/` plus that recipe's id. **Save** keeps the recipe on this phone and opens it. **Cancel** leaves without saving. **Delete** asks first, then removes the recipe from this phone.
- The starting recipes are read from `data/recipes.json` each visit (or from an offline copy of that file when the phone cannot reach it). Recipes you add or edit, and seed recipes you delete, are stored in a separate note (`recipe-app.userRecipes`). A newer copy of the file can add recipes without wiping those changes. An edited seed recipe keeps your version. The grocery list stays in its own note (`recipe-app.grocery`). Cooking does not write either note.

Search ignores capitals and accents, so `aioli` finds `aïoli`.

## Files

- `index.html` — the page skeleton: search box, recipe list, recipe screen, cooking screen, grocery list, add and edit form, and the bottom bar.
- `styles.css` — colors, type size, and spacing, aimed at a phone screen.
- `app.js` — loading, search, the recipe screen, cooking mode, the grocery list, and add, edit, and delete. The comments explain the flow.
- `data/recipes.json` — the starting recipes.
- `.nojekyll` — an empty file that tells GitHub Pages to publish these files as they are.

Start with `index.html`, then `styles.css`, then `app.js`.

## Try it on your computer

From this folder:

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080/

## Update the starting recipes later

Edit `data/recipes.json`. The next visit that can reach the file picks up new seed recipes. Recipes someone added, edited, or deleted on their phone stay as they left them. You do not change a version number. An edited seed recipe keeps that person's version, matched by id, so leave existing ids alone when you add a recipe to the file.
