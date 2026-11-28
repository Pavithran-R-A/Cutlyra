struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    // Wipe axis: the edge travels along this unit vector.
    direction: vec2f,
    // x = progress (0..1), y = softness (normalised edge width)
    scalars: vec4f,
    scalars2: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// Directional wipe: the incoming layer is revealed behind an edge that sweeps
// across the frame. Everything the edge has not reached yet is transparent, so
// the layer underneath (the outgoing clip) shows through.
//
// Semantics shared with `EdlWipeEffect`:
//   direction points the way the edge travels (left = edge moves left, so the
//   reveal starts at the RIGHT edge), and `progress` 0 -> 1 sweeps the edge
//   across the full frame plus one softness band on either side.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);

    let vertical = abs(uniforms.direction.y) > abs(uniforms.direction.x);
    let moving_positive = select(uniforms.direction.x, uniforms.direction.y, vertical) > 0.0;
    var coord = select(input.tex_coord.x, input.tex_coord.y, vertical);
    if (!moving_positive) {
        coord = 1.0 - coord;
    }

    let softness = max(uniforms.scalars.y, 0.0001);
    let progress = clamp(uniforms.scalars.x, 0.0, 1.0);
    let edge = mix(-softness, 1.0 + softness, progress);
    let visible = 1.0 - smoothstep(edge - softness, edge + softness, coord);

    return vec4f(color.rgb, color.a * visible);
}
