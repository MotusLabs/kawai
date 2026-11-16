## Purpose

Delivers the web client's static assets compressed and with cache headers, so the app loads and updates quickly over slow links.

## ADDED Requirements

### Requirement: Static assets are served compressed
The production build SHALL write a brotli and a gzip copy of every text asset of the web client (JavaScript, CSS, HTML, SVG, JSON and the web manifest). The server SHALL serve the brotli copy to a request whose `Accept-Encoding` lists `br`, otherwise the gzip copy to one that lists `gzip`, otherwise the original, with matching `Content-Encoding` and `Vary: Accept-Encoding` headers. The decoded body SHALL equal the original file byte for byte.

#### Scenario: A browser accepting brotli
- **WHEN** a browser requests the main JavaScript bundle with `Accept-Encoding: gzip, deflate, br`
- **THEN** the response carries the brotli copy with `Content-Encoding: br` and `Vary: Accept-Encoding`, and decodes to the original bundle

#### Scenario: A client accepting only gzip
- **WHEN** a client requests the bundle with `Accept-Encoding: gzip`
- **THEN** the response carries the gzip copy with `Content-Encoding: gzip`

#### Scenario: A client accepting no encoding
- **WHEN** a client requests the bundle without `Accept-Encoding`
- **THEN** the response carries the original file with no `Content-Encoding`

#### Scenario: An asset without a compressed copy
- **WHEN** a client requests an asset that has no compressed copy, such as a PNG image
- **THEN** the original file is served unchanged

### Requirement: Content-hashed assets are cached as immutable
Assets whose file names carry a build content hash SHALL be served with `Cache-Control: public, max-age=31536000, immutable`. `index.html`, the service worker script, and the web manifest SHALL be served with `Cache-Control: no-cache`, so a new build is discovered on the next load.

#### Scenario: A hashed bundle
- **WHEN** a browser requests `assets/index-<hash>.js`
- **THEN** the response carries `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: The app shell
- **WHEN** a browser requests `index.html` or the service worker script
- **THEN** the response carries `Cache-Control: no-cache`

#### Scenario: An update changes only the shell's references
- **WHEN** a new build is installed and the browser loads the app again
- **THEN** it revalidates `index.html`, and requests only those hashed assets whose names changed
