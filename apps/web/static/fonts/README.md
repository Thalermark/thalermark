# Vendored brand fonts

These `.woff2` files are self-hosted so the web app makes **no third-party font
requests** — a privacy win on the public invoice/pay pages, and what lets the
Content-Security-Policy keep a clean `font-src 'self'`. They are served
same-origin and referenced by `static/brand-fonts.css`.

## Fonts & licenses

All three are **SIL Open Font License 1.1** (see the `*-LICENSE.txt` files here),
which permits bundling and redistribution:

| Family        | Source (Fontsource, OFL-1.1)          | Version | Axes vendored  |
| ------------- | ------------------------------------- | ------- | -------------- |
| Fraunces      | `@fontsource-variable/fraunces`       | 5.2.9   | `opsz` + `wght` (standard) |
| Inter         | `@fontsource-variable/inter`          | 5.2.8   | `wght`         |
| JetBrains Mono| `@fontsource-variable/jetbrains-mono` | 5.2.8   | `wght`         |

Only the `latin` + `latin-ext` subsets are vendored; `brand-fonts.css` uses
`unicode-range` so the `-ext` file only downloads when an accented glyph appears.

## Regenerating (font update)

The three `@fontsource-variable/*` packages are kept as **dev-dependencies** of
`apps/web` purely to pin the exact upstream font version and make re-copying
reproducible — nothing imports them at runtime (the served files are the
vendored `.woff2` here). To refresh after bumping a version:

```sh
FS=apps/web/node_modules/@fontsource-variable
cp $FS/fraunces/files/fraunces-latin-standard-normal.woff2         apps/web/static/fonts/fraunces-latin.woff2
cp $FS/fraunces/files/fraunces-latin-ext-standard-normal.woff2     apps/web/static/fonts/fraunces-latin-ext.woff2
cp $FS/inter/files/inter-latin-wght-normal.woff2                   apps/web/static/fonts/inter-latin.woff2
cp $FS/inter/files/inter-latin-ext-wght-normal.woff2              apps/web/static/fonts/inter-latin-ext.woff2
cp $FS/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2      apps/web/static/fonts/jetbrains-mono-latin.woff2
cp $FS/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2  apps/web/static/fonts/jetbrains-mono-latin-ext.woff2
```
