;; LUCID pixel kernels (WebAssembly SIMD). Assembled by scripts/gen-wasm.mjs into pxBinary.ts.
;;
;; Every function here reproduces a JavaScript reference implementation bit for bit, so using it changes
;; speed only, never results (see tests/unit/wasm.test.ts):
;;   f32_to_u8  = storing into a Uint8ClampedArray (ECMAScript ToUint8Clamp: NaN -> 0, clamp to 0..255,
;;                round half to even). Verified over all 2^32 float32 bit patterns.
;;   hist_u8    = the display histogram of engine.render (integer BT.601 luma, saturation counts).
;;
;; Memory map (6 pages = 384 KiB, fixed): the caller streams frames through in chunks.
;;   0      .. 262143   input chunk, up to 65536 float32
;;   262144 .. 327679   output chunk, up to 65536 bytes
;;   327680 .. 331783   histogram: u32 R[256] G[256] B[256] L[256], then low, high
(module
  (memory (export "mem") 6)

  (func (export "f32_to_u8") (param $s i32) (param $d i32) (param $n i32)
    (local $end i32) (local $v f32) (local $i i32)
    (local.set $end (i32.add (local.get $s) (i32.shl (i32.and (local.get $n) (i32.const -16)) (i32.const 2))))
    (block $done
      (loop $vec
        (br_if $done (i32.ge_u (local.get $s) (local.get $end)))
        ;; nearest (ties to even) -> saturating i32 (NaN -> 0) -> saturating narrow to i16 -> to u8 (clamps 0..255)
        (v128.store (local.get $d)
          (i8x16.narrow_i16x8_u
            (i16x8.narrow_i32x4_s
              (i32x4.trunc_sat_f32x4_s (f32x4.nearest (v128.load offset=0 (local.get $s))))
              (i32x4.trunc_sat_f32x4_s (f32x4.nearest (v128.load offset=16 (local.get $s)))))
            (i16x8.narrow_i32x4_s
              (i32x4.trunc_sat_f32x4_s (f32x4.nearest (v128.load offset=32 (local.get $s))))
              (i32x4.trunc_sat_f32x4_s (f32x4.nearest (v128.load offset=48 (local.get $s)))))))
        (local.set $s (i32.add (local.get $s) (i32.const 64)))
        (local.set $d (i32.add (local.get $d) (i32.const 16)))
        (br $vec)))
    (local.set $i (i32.and (local.get $n) (i32.const 15)))
    (block $tdone
      (loop $tail
        (br_if $tdone (i32.eqz (local.get $i)))
        (local.set $v (f32.nearest (f32.load (local.get $s))))
        (i32.store8 (local.get $d)
          (select (i32.const 255)
            (select (i32.trunc_sat_f32_s (local.get $v)) (i32.const 0) (f32.gt (local.get $v) (f32.const 0)))
            (f32.ge (local.get $v) (f32.const 255))))
        (local.set $s (i32.add (local.get $s) (i32.const 4)))
        (local.set $d (i32.add (local.get $d) (i32.const 1)))
        (local.set $i (i32.sub (local.get $i) (i32.const 1)))
        (br $tail))))

  ;; Accumulate the histograms of $n RGBA8 pixels at $p into the counters at $h (see the memory map).
  (func (export "hist_u8") (param $p i32) (param $n i32) (param $h i32)
    (local $end i32) (local $r i32) (local $g i32) (local $b i32) (local $a i32) (local $lo i32) (local $hi i32)
    (local.set $end (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 2))))
    (local.set $lo (i32.load offset=4096 (local.get $h)))
    (local.set $hi (i32.load offset=4100 (local.get $h)))
    (block $done
      (loop $px
        (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
        (local.set $r (i32.load8_u offset=0 (local.get $p)))
        (local.set $g (i32.load8_u offset=1 (local.get $p)))
        (local.set $b (i32.load8_u offset=2 (local.get $p)))
        (local.set $a (i32.add (local.get $h) (i32.shl (local.get $r) (i32.const 2))))
        (i32.store offset=0 (local.get $a) (i32.add (i32.load offset=0 (local.get $a)) (i32.const 1)))
        (local.set $a (i32.add (local.get $h) (i32.shl (local.get $g) (i32.const 2))))
        (i32.store offset=1024 (local.get $a) (i32.add (i32.load offset=1024 (local.get $a)) (i32.const 1)))
        (local.set $a (i32.add (local.get $h) (i32.shl (local.get $b) (i32.const 2))))
        (i32.store offset=2048 (local.get $a) (i32.add (i32.load offset=2048 (local.get $a)) (i32.const 1)))
        ;; luma = (299 R + 587 G + 114 B + 500) / 1000, integer division (the JS reference truncates the quotient)
        (local.set $a (i32.add (local.get $h) (i32.shl
          (i32.div_u
            (i32.add (i32.add (i32.add (i32.mul (local.get $r) (i32.const 299)) (i32.mul (local.get $g) (i32.const 587)))
                              (i32.mul (local.get $b) (i32.const 114))) (i32.const 500))
            (i32.const 1000))
          (i32.const 2))))
        (i32.store offset=3072 (local.get $a) (i32.add (i32.load offset=3072 (local.get $a)) (i32.const 1)))
        (local.set $lo (i32.add (local.get $lo)
          (i32.or (i32.or (i32.eqz (local.get $r)) (i32.eqz (local.get $g))) (i32.eqz (local.get $b)))))
        (local.set $hi (i32.add (local.get $hi)
          (i32.or (i32.or (i32.eq (local.get $r) (i32.const 255)) (i32.eq (local.get $g) (i32.const 255))) (i32.eq (local.get $b) (i32.const 255)))))
        (local.set $p (i32.add (local.get $p) (i32.const 4)))
        (br $px)))
    (i32.store offset=4096 (local.get $h) (local.get $lo))
    (i32.store offset=4100 (local.get $h) (local.get $hi)))
)
