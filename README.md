# Celestial Goods

A static website for Celestial Goods, an organic and artisanal delicacies storefront.

## Preview the site locally

1. Open a terminal in the repository root.
2. Run:
   ```bash
   cd dist
   python3 -m http.server 8000
   ```
3. Open these URLs in your browser:
   - **Brochure landing:** http://localhost:8000
   - **Online shop:** http://localhost:8000/shop.html

## About the build

- The preview site is served from the `dist/` folder.
- `dist/index.html` is the PDF-aligned brochure landing page (brand story, products, contact).
- `dist/shop.html` loads the full e-commerce store (cart, COD, admin) from `dist/assets/`.

## Notes

- The project currently contains the built static output. If you want to work from source, add the app source files alongside this repository.
- Update the WhatsApp link in `dist/index.html` when a phone number is available (currently uses a placeholder).
