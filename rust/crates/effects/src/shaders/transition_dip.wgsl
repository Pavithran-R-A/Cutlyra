struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    // x = amount (0..1): how far the frame has been pulled to `scalars2.rgb`
    scalars: vec4f,
    // rgb = dip colour (black or white), a = unused
    scalars2: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// Dip to a solid colour: mix every pixel toward the dip colour. Alpha is
// untouched so the cross-fade stacking still decides which layer is visible.
// `EdlDipEffect` uses the identical mix.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let amount = clamp(uniforms.scalars.x, 0.0, 1.0);
    return vec4f(mix(color.rgb, uniforms.scalars2.rgb, amount), color.a);
}
