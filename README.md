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
- The first visit copies `data/recipes.json` onto the phone (the browser's localStorage). The grocery list is saved in its own note, separate from the recipes. Both stay on the phone after a reload.

Search ignores capitals and accents, so `aioli` finds `aïoli`.

## Files

- `index.html` — the page skeleton: search box, recipe list, recipe screen, grocery list, and the bottom bar.
- `styles.css` — colors, type size, and spacing, aimed at a phone screen.
- `app.js` — loading, search, the recipe screen, and the grocery list. The comments explain the flow.
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

Edit `data/recipes.json`, then in `app.js` change `DATA_VERSION` from `"1"` to `"2"`. The next visit replaces the copy saved on the phone.
