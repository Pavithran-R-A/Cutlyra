struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    // xyz = key colour RGB, w = similarity distance on the Cb/Cr plane
    scalars: vec4f,
    // x = edge softness distance, y = spill amount (0..1), zw unused
    scalars2: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// Rec.709 luma weights and chroma scaling — the same constants as
// `effects/chroma-key.ts` and `ChromaKeyMath.kt`.
const LUMA = vec3f(0.2126, 0.7152, 0.0722);
const CB_SCALE: f32 = 1.8556;
const CR_SCALE: f32 = 1.5748;

fn chroma(rgb: vec3f) -> vec2f {
    let luma = dot(rgb, LUMA);
    return vec2f((rgb.b - luma) / CB_SCALE, (rgb.r - luma) / CR_SCALE);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let sampled = textureSample(input_texture, input_sampler, input.tex_coord);
    let key = uniforms.scalars.xyz;

    let distance = length(chroma(sampled.rgb) - chroma(key));
    let threshold = uniforms.scalars.w;
    let edge = max(uniforms.scalars2.x, 1e-4);
    let alpha = smoothstep(threshold, threshold + edge, distance);

    // Spill: pull the green channel down toward max(r, b) only where green is
    // the dominant channel, so a red subject the key keeps is untouched.
    var rgb = sampled.rgb;
    let excess = max(0.0, rgb.g - max(rgb.r, rgb.b));
    rgb.g = max(0.0, rgb.g - excess * uniforms.scalars2.y);

    return vec4f(rgb, sampled.a * alpha);
}
