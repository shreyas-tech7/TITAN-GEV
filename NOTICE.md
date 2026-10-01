# Attribution and third party terms

## God's Eye View

This project hosts and gates God's Eye View. It does not copy, fork, or modify the
upstream code. The Docker build fetches the exact commit named in `UPSTREAM_COMMIT`
from <https://github.com/bilawalsidhu/gods-eye-view> and builds it unchanged.

- Project: God's Eye View
- Author: Bilawal Sidhu
- Source: <https://github.com/bilawalsidhu/gods-eye-view>
- License: MIT, reproduced below

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The built image keeps the upstream `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `DATA_SOURCES.md`
files inside `/app/upstream`.

## The MIT license covers upstream source code only

Upstream states that its MIT grant does not extend to the datasets, live data feeds, or 3D
models it uses. Those remain under their own terms. Three points matter here:

- The TeleGeography submarine cable data is CC BY-NC-SA 3.0. It is not for commercial use.
- The Bhote Koshi event imagery and flood path data are CC BY-NC 4.0. They are not for commercial use.
- Datacenter and dam extracts from OpenStreetMap carry the ODbL, which requires attribution and share-alike.

The 3D models under `public/models/` and the live providers (OpenSky, adsb.lol, CelesTrak,
USGS, OSM Overpass, Esri, and others) have their own licenses and terms as well.
See upstream `DATA_SOURCES.md` and `public/models/README.md`.

**Use of this deployment is personal and non-commercial.** It is a private dashboard tab for
one person. Anyone who reuses this repository commercially must remove or relicense the
non-commercial datasets first.

## Cesium

The globe uses CesiumJS and an optional Cesium ion token. Cesium ion Community plan limits and
terms apply to that token. Restrict the token under Allowed URLs to the hosting origin.
