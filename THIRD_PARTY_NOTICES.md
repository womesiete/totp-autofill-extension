# Third-party notices

## otplib

This project uses `otplib` for RFC 6238 TOTP generation.

- License: MIT
- Copyright: otplib contributors

The package and its transitive dependencies are bundled into the local extension build by Webpack. No third-party code is fetched at extension runtime.

## Webpack and copy-webpack-plugin

Webpack and copy-webpack-plugin are development-only build dependencies. They are used to create self-contained local extension bundles and copy static assets into `dist/`.

Their respective license texts are available in the installed npm packages and upstream repositories.
