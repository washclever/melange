# Third-party components

Melange itself is MIT licensed ([LICENSE](LICENSE)). What follows is the third-party code
distributed alongside it.

The build output (`dist/`) **contains `spice.wasm`, ngspice compiled to WebAssembly, as is.**
BSD-family licenses require the copyright notice, the conditions and the warranty disclaimer to be
distributed with a binary redistribution, so this file ships with it.

---

## eecircuit-engine

The package that bundles ngspice built to WebAssembly. <https://github.com/eelab-dev/EEcircuit-engine>

```
MIT License

Copyright (c) 2024 EElab.dev

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

**Modifications** — the engine's JavaScript loader is changed in two ways at build time
(`vite.config.ts`). Instead of carrying the wasm inline as base64 it reads a separate asset, and
**the foundry PDK model cards bundled with it (SKY130 · GlobalFoundries · FreePDK · PTM) are
stripped out.** Those models each follow their own license as third-party data, and we do not
redistribute them. `spice.wasm` itself is the bytes contained in the package, extracted unmodified
(`tools/extract-wasm.mjs`).

---

## ngspice (`spice.wasm`)

<https://ngspice.sourceforge.io/> · full license document:
<https://github.com/imr/ngspice/blob/master/COPYING>

ngspice has a history of merging Spice3f5, XSPICE, CIDER, numparam and more, so **several licenses
are mixed in.** The base license that applies to the whole is 'Modified BSD'.

```
Copyright 1985 - 2018, Regents of the University of California and others

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation
and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
contributors may be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### Components under other licenses

These are the ones actually confirmed inside the `spice.wasm` we ship (checked against the strings
in the binary).

| Component | License | In the wasm? |
| --- | --- | --- |
| ngspice proper · Spice3f5 · BSIM models | Modified BSD | yes |
| `src/maths/sparse` | MIT (New BSD compatible) | yes (the default solver) |
| `src/maths/KLU` | LGPLv2 | yes |
| `src/frontend/numparam` | LGPLv2 or later | yes |
| `src/osdi` | MPLv2.0 | yes |
| `src/xspice` | public domain (Georgia Tech) | yes |
| `src/xspice/icm/table` | GPLv2 or later | **no** |
| `src/tclspice.c` | LGPLv2 | no |
| `src/spicelib/devices/ndev` | public domain | no |

The sources of the LGPL and MPL parts have to be obtainable, so **the exact version we use and
where to get it are written down here.**

- `spice.wasm` is the bytes contained in the npm package `eecircuit-engine` (the version recorded in
  `package.json`), extracted without modification. The extraction code is `tools/extract-wasm.mjs`.
- That package's source and build instructions: <https://github.com/eelab-dev/EEcircuit-engine>
- ngspice sources: <https://sourceforge.net/projects/ngspice/files/> ·
  <https://github.com/imr/ngspice>

---

## SKY130 PDK (`sky130.spice`)

The SKY130 parts in the library use SkyWater's own BSIM4 model cards, not models we
wrote. The build pulls them out of the engine bundle and splits them per device
(`tools/extract-sky130.mjs`); the worker fetches a file only when a schematic actually
contains that device, so a circuit of resistors never downloads any of them.

<https://github.com/google/skywater-pdk>

```
Copyright 2020 The SkyWater PDK Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The notice above is the one carried inside the model file itself, and that file ships
with its full text intact. What reaches the deployed site is the subset the engine
bundles: three subcircuits (`sky130_fd_pr__nfet_01v8`, `sky130_fd_pr__pfet_01v8`,
`sky130_fd_pr__pfet_01v8_hvt`) and their 327 binned `.model` cards, one process corner.
It is not the whole PDK, and it is not a sign-off model deck.

## Analog layout (`src/layout/`)

The layout flow (schematic → primitives → placement → routing → DRC/LVS → GDS) is built from the
following. The front end in `src/layout/front/` is a JavaScript re-implementation of ALIGN's compiler and
SKY130 primitive cell generator, written so that the same input produces the same output as the Python
originals (`tools/verify-front.ts` checks this against reference outputs). No Python and no Pyodide are
shipped.

### ALIGN (ALIGN-public)

<https://github.com/ALIGN-analoglayout/ALIGN-public> — the compiler (`align/compiler`, `align/schema`),
the cell fabric (`align/cell_fabric`), the primitive driver (`align/primitive`), the router (ported to
Rust/WebAssembly as `src/layout/route/alignroute.wasm`) and the checker are ported from it. The primitive
template netlists in `src/layout/front/compiler/templates.mjs` (`basic_template.sp`, `user_template.sp`)
are copied unchanged, and so are the example netlists in `src/layout/examples/netlists.ts` (from `examples/`,
with only their `PowerPorts` / `GroundPorts` constraints kept); Melange redraws them as SKY130 schematics.

```
BSD 3-Clause License

Copyright (c) 2018, 2019, Regents of the University of Minnesota, Texas A&M University, Intel Corporation
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

**Modifications** — translated from Python to JavaScript; Z3 consistency checks of generated constraints
are not run (auto-generated symmetry constraints use each device once and cannot conflict); capacitor,
resistor and guard-ring cells, user `GroupBlocks`/`GroupCaps` are not ported yet; the checker's device
layers are taken from the SKY130 cell canvas.

### ALIGN-pdk-sky130

<https://github.com/ALIGN-analoglayout/ALIGN-pdk-sky130> — `SKY130_PDK/layers.json`
(`src/layout/pdk/sky130.mjs`), `models.sp` (copied unchanged into `templates.mjs`), `mos.py` and
`gen_param.py` (ported to `src/layout/front/sky130/`).

```
BSD 3-Clause License

Copyright (c) 2021, ALIGN-analoglayout
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### NetworkX

<https://networkx.org> — the VF2 subgraph matcher (`isomorphvf2.py`, `vf2userfunc.py`) and the parts of
`Graph` ALIGN relies on are ported to `src/layout/front/compiler/nx.mjs`, keeping NetworkX's search order.

```
Copyright (c) 2004-2026, NetworkX Developers
Aric Hagberg <hagberg@lanl.gov>
Dan Schult <dschult@colgate.edu>
Pieter Swart <swart@lanl.gov>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above
    copyright notice, this list of conditions and the following
    disclaimer in the documentation and/or other materials provided
    with the distribution.

  * Neither the name of the NetworkX Developers nor the names of its
    contributors may be used to endorse or promote products derived
    from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### CPython

<https://www.python.org> — ALIGN's output depends on Python's set iteration order and hash values.
`src/layout/front/py.mjs` re-implements the relevant parts of CPython 3.13 (`Objects/setobject.c` set
table, SipHash-1-3 string hash with `PYTHONHASHSEED=0`, tuple and int hashes) so the order matches.
Summary of changes: only the hashing and set-table algorithms are re-implemented, in JavaScript.

```
Copyright (c) 2001-2024 Python Software Foundation; All Rights Reserved

PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001-2024 Python Software Foundation; All Rights Reserved"
are retained in Python alone or in any derivative version prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.
```

---

## What is not used

- **No EasyEDA code, icons, images, symbol graphics, part data or documentation text is included.**
  Only the interactions (behavior such as shortcut assignments and panel layout) follow its public
  documentation; the implementation is entirely our own.
- The generic semiconductor parts (diode, NPN/PNP, NMOS/PMOS) use `.model` cards we wrote
  from textbook values (DGEN · QNGEN · MNGEN), not vendor models. The SKY130 parts are the
  one exception and are covered above.
- The other foundry model cards the engine carries — GlobalFoundries GF180, FreePDK45,
  PDK15, PTM, CMOS90 — are stripped at build time and never shipped (see "Modifications").

EasyEDA · LCSC · JLCPCB · ngspice · SPICE are trademarks of their respective owners. This project
has no affiliation with any of them.
