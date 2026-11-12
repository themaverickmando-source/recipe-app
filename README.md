# Manolo's recipes

A recipe book that opens in the phone browser. Plain HTML, CSS, and JavaScript. No build step and no frameworks.

Published with GitHub Pages from the `main` branch, root folder:

https://themaverickmando-source.github.io/recipe-app/

## What you will see

- A search box and a card for each recipe.
- Tap a card to open the recipe. The address becomes `#recipe/` plus that recipe's id.
- The phone Back button returns to the list. There is also a **Back to recipes** button.
- The first visit copies `data/recipes.json` onto the phone (the browser's localStorage). Later visits read that saved copy.

Search ignores capitals and accents, so `aioli` finds `aïoli`.

## Files

- `index.html` — the page skeleton: search box, list, and the place a recipe appears.
- `styles.css` — colors, type size, and spacing, aimed at a phone screen.
- `app.js` — loading, search, and the recipe screen. The comments explain the flow.
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
