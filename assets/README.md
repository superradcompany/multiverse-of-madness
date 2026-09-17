# engine assets

The application uses wasmdoom (GPL-2.0) and Freedoom: Phase 1 (BSD-3-Clause).
They are downloaded separately; no commercial Doom WAD is required.

- Engine source: https://github.com/theMagicalKarp/wasmdoom/tree/dd321b50b89b5085698cfbf2ff01b2f741da8206
- Engine binary: https://themagicalkarp.github.io/wasmdoom/wasmdoom.wasm
- Engine SHA-256: caa3d9152830738325d0b0b2b1448c4cef25edeed1e3a5f979f6c7bbfada1683
- Freedoom data: https://github.com/theMagicalKarp/wasmdoom/blob/dd321b50b89b5085698cfbf2ff01b2f741da8206/wads/freedoom1.wad
- Data SHA-256: 7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d
- Freedoom source and license: https://github.com/freedoom/freedoom

The engine binary is hash-pinned. Its public download URL can change; setup fails
on a hash mismatch rather than silently accepting a different ABI. The recorded
source revision documents the ABI inspected during implementation; a reproducible
source build still needs qualification before distributing engine binaries.
