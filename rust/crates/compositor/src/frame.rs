use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    /// Normalised UV rectangle sampled from the layer's texture. Absent means
    /// the full texture, which is exactly how every pre-crop frame encoded.
    #[serde(default)]
    pub source_rect: Option<SourceRectDescriptor>,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRectDescriptor {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl SourceRectDescriptor {
    pub fn full() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }

    /// `[x0, y0, x1, y1]` in texture UV space, clamped to the texture.
    pub fn uv_bounds(&self) -> [f32; 4] {
        let x0 = self.x.clamp(0.0, 1.0);
        let y0 = self.y.clamp(0.0, 1.0);
        let x1 = (self.x + self.width).clamp(0.0, 1.0);
        let y1 = (self.y + self.height).clamp(0.0, 1.0);
        [x0, y0, x1.max(x0), y1.max(y0)]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_layer_json_without_source_rect_still_parses() {
        let json = r#"{
            "textureId": "t",
            "transform": {"centerX": 1.0, "centerY": 2.0, "width": 3.0, "height": 4.0, "rotationDegrees": 0.0, "flipX": false, "flipY": false},
            "opacity": 1.0,
            "blendMode": "normal",
            "mask": null
        }"#;
        let layer: LayerDescriptor = serde_json::from_str(json).expect("legacy layer");
        assert!(layer.source_rect.is_none());
        assert!(layer.effect_pass_groups.is_empty());
    }

    #[test]
    fn source_rect_round_trips_and_clamps() {
        let json = r#"{
            "textureId": "t",
            "transform": {"centerX": 1.0, "centerY": 2.0, "width": 3.0, "height": 4.0, "rotationDegrees": 0.0, "flipX": false, "flipY": false},
            "sourceRect": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.4},
            "opacity": 1.0,
            "blendMode": "normal",
            "mask": null
        }"#;
        let layer: LayerDescriptor = serde_json::from_str(json).expect("cropped layer");
        let rect = layer.source_rect.expect("source rect");
        assert_eq!(rect.uv_bounds(), [0.25, 0.1, 0.75, 0.5]);

        let overflow = SourceRectDescriptor {
            x: -0.5,
            y: 0.8,
            width: 2.0,
            height: 2.0,
        };
        assert_eq!(overflow.uv_bounds(), [0.0, 0.8, 1.0, 1.0]);
    }
}
