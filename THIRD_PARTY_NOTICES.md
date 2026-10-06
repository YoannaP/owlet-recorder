# Third-party notices

owlet-recorder's own code is under the [MIT license](LICENSE). The repository
also bundles one third-party file.

## plotly.js 2.35.2

`box/plotly.min.js` is the unmodified `plotly.min.js` from the npm package
[`plotly.js-dist-min@2.35.2`](https://www.npmjs.com/package/plotly.js-dist-min/v/2.35.2)
(SHA-256 `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`).
It is vendored so the dashboards load nothing from a CDN.

Licences of the libraries bundled inside it are in
[`box/plotly.min.js.LICENSE.txt`](box/plotly.min.js.LICENSE.txt), copied
from `plotly.js@2.35.2/dist`.

```
The MIT License (MIT)

Copyright (c) 2021 Plotly, Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Not bundled

Python and npm dependencies (`aiohttp`, `certifi`, `pyowletapi`, and
`playwright` for tests) are installed from their registries under their own
licences and are not redistributed here.
