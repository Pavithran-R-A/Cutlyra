struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

// Layout MUST match `LayerUniformBuffer` in compositor.rs byte for byte
// (64 bytes, `#[repr(C)]`, f32 alignment only):
//
//   0  resolution        vec2f  (8)
//   8  center            vec2f  (8)
//  16  size              vec2f  (8)
//  24  rotation_radians  f32    (4)
//  28  opacity           f32    (4)
//  32  flip_x            f32    (4)
//  36  flip_y            f32    (4)
//  40  source_rect       [x0, y0, x1, y1] as four f32 (16)
//  56  _padding          vec2f  (8)
//      -------------------------------- 64 total
//
// The crop rectangle is deliberately four scalars, not `vec4f`: a `vec4f`
// member has 16-byte alignment, so WGSL would place it at offset 48 while
// `#[repr(C)]` in Rust puts the `[f32; 4]` at 40. That mismatch made the
// published layer uniform 64 bytes against an 80-byte shader binding, and
// every preview frame failed pipeline validation (black canvas).
// `crates/compositor/src/compositor.rs` has a test pinning these offsets.
struct LayerUniforms {
    resolution: vec2f,
    center: vec2f,
    size: vec2f,
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    // [x0, y0, x1, y1] in source UV space: the crop rectangle.
    source_rect_x0: f32,
    source_rect_y0: f32,
    source_rect_x1: f32,
    source_rect_y1: f32,
    _padding: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: LayerUniforms;

fn rotate_inverse(point: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(
        point.x * c + point.y * s,
        -point.x * s + point.y * c,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let pixel = input.tex_coord * uniforms.resolution;
    let local = rotate_inverse(pixel - uniforms.center, uniforms.rotation_radians);

    let uv = vec2f(
        local.x / uniforms.size.x + 0.5,
        local.y / uniforms.size.y + 0.5,
    );

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    // Mirror inside the quad first, then map the quad's 0..1 UV onto the
    // cropped sub-rectangle of the texture. Both are affine per axis, so the
    // mirror stays a mirror of the CROPPED content and the uncropped case
    // (0,0,1,1) reduces to the original sampling exactly.
    let mirrored_uv = vec2f(
        select(uv.x, 1.0 - uv.x, uniforms.flip_x > 0.5),
        select(uv.y, 1.0 - uv.y, uniforms.flip_y > 0.5),
    );
    let sample_uv = vec2f(
        mix(uniforms.source_rect_x0, uniforms.source_rect_x1, mirrored_uv.x),
        mix(uniforms.source_rect_y0, uniforms.source_rect_y1, mirrored_uv.y),
    );
    let color = textureSampleLevel(source_texture, source_sampler, sample_uv, 0.0);
    return vec4f(color.rgb, color.a * uniforms.opacity);
}
