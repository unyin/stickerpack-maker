//! Selection composition (SPEC §6, SPM-23): merge the contributions of a
//! floating selection — wand fills in their own grids, Rectangle/Lasso
//! polygons in document pixels, each tagged add or subtract — into ONE
//! grid's coverage mask. One-shot pixel work in Rust (ADR-0005), like the
//! wand it serves.
//!
//! The grid is wherever the selection is resolved: the target layer's own
//! pixel grid when Cut or Delete applies it, or the document's for the
//! dashed-outline preview. Polygons rasterise through the grid transform's
//! inverse with cut's `spans` (pixel-centre even-odd, whole pixels), the
//! exact primitive a plain Rectangle/Lasso erase uses; a wand mask is
//! sampled at the mapped pixel centre of its source grid, which is the raw
//! byte when the two placements match (every tested flow, so pixel
//! outcomes stay identical). The fold is the wand's own algebra: add takes
//! the stronger coverage, subtract removes the contribution's coverage
//! outright (floored at nothing). Coverage is 255 inside a polygon and 128
//! on its feather ring beside the polygon's own outside, never at the
//! grid's own edge (the wand's exception mirrored); a hard contribution
//! stays 255 throughout (the Feather checkbox off).

use serde::Deserialize;
use tiny_skia::{Point, Transform};

use super::cut::spans;
use super::placement::{transform_of, LayerTransform, MAX_LAYER_SIDE};
use super::wand::{WandMask, FEATHER, INSIDE};

/// What a contribution does to the coverage built before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    /// Take the stronger coverage where the contribution reaches.
    Add,
    /// Remove the contribution's coverage outright.
    Subtract,
}

/// One piece of a floating selection, in the order it was added.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Contribution {
    /// A Rectangle/Lasso polygon, in document pixels.
    Poly {
        op: Op,
        /// Whether the boundary takes half coverage; hard when absent.
        #[serde(default)]
        feather: bool,
        points: Vec<[f32; 2]>,
    },
    /// A wand fill's coverage in the grid it was filled in, placed by that
    /// layer's transform. Its bytes follow in the raw body, in order.
    Mask {
        op: Op,
        /// The mask's top-left and size in its own source grid.
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        /// Where the source grid sits in the document.
        transform: LayerTransform,
    },
}

/// Why a selection cannot start by subtracting.
pub const SUBTRACT_FIRST: &str = "a selection cannot start by subtracting: there is nothing to take from";

/// Metadata of a compose request: the grid the selection merges into and its
/// contributions in order. The mask contributions' coverage bytes are the
/// raw body, concatenated in that order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeMeta {
    pub width: u32,
    pub height: u32,
    /// Where the grid sits in the document.
    pub transform: LayerTransform,
    pub contributions: Vec<Contribution>,
}

/// Merge `meta`'s contributions into its grid's coverage mask, cropped to
/// the covered bounds; a stack that covers nothing is a zero-sized mask.
pub fn compose(meta: &ComposeMeta, body: &[u8]) -> Result<WandMask, String> {
    let (width, height) = (meta.width, meta.height);
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .filter(|pixels| *pixels > 0 && *pixels <= MAX_LAYER_SIDE as usize * MAX_LAYER_SIDE as usize)
        .ok_or_else(|| "the selection's grid has no pixels or is too large".to_string())?;
    let expected = meta.contributions.iter().try_fold(0usize, |total, contribution| match contribution {
        Contribution::Mask { width, height, .. } => {
            let len = mask_len(*width, *height)?;
            total.checked_add(len).ok_or_else(|| "the selection's masks are too large".to_string())
        }
        Contribution::Poly { .. } => Ok(total),
    })?;
    if body.len() < expected {
        return Err("the request body is shorter than the selection's masks".to_string());
    }
    if body.len() > expected {
        return Err("the request body is longer than the selection's masks".to_string());
    }
    if meta.contributions.first().is_some_and(|first| first.op() == Op::Subtract) {
        return Err(SUBTRACT_FIRST.to_string());
    }
    // tiny-skia's inverse of a zero scale is an infinity, not a refusal, so
    // a degenerate grid is refused here (cut's wording).
    if meta.transform.scale_x == 0.0 || meta.transform.scale_y == 0.0 {
        return Err("the layer is scaled to nothing, so it cannot be cut".to_string());
    }
    let grid = transform_of(&meta.transform)?;
    let inverse = grid
        .invert()
        .ok_or_else(|| "the layer is scaled to nothing, so it cannot be cut".to_string())?;
    let mut coverage = vec![0u8; pixels];
    let mut rest = body;
    for contribution in &meta.contributions {
        match contribution {
            Contribution::Poly { op, feather, points } => {
                let poly = poly_coverage(points, *feather, (width, height), &inverse)?;
                fold(&mut coverage, &poly, *op);
            }
            Contribution::Mask { op, x, y, width: mask_width, height: mask_height, transform } => {
                let len = mask_len(*mask_width, *mask_height)?;
                let (bytes, tail) = rest.split_at(len);
                rest = tail;
                let laid = mask_coverage(bytes, (*x, *y, *mask_width, *mask_height), transform, &meta.transform, &inverse, (width, height))?;
                fold(&mut coverage, &laid, *op);
            }
        }
    }
    Ok(cropped(coverage, width, height))
}

impl Contribution {
    fn op(&self) -> Op {
        match self {
            Contribution::Poly { op, .. } | Contribution::Mask { op, .. } => *op,
        }
    }
}

/// The body bytes one mask contribution's coverage takes: its pixel count,
/// refused when the width times height overflows.
fn mask_len(width: u32, height: u32) -> Result<usize, String> {
    (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "the selection's masks are too large".to_string())
}

/// Fold one contribution into the coverage built so far: add takes the
/// stronger coverage, subtract removes the contribution's outright, floored
/// at nothing (the wand's own algebra, SPM-22).
fn fold(base: &mut [u8], contribution: &[u8], op: Op) {
    for (b, f) in base.iter_mut().zip(contribution) {
        *b = match op {
            Op::Add => (*b).max(*f),
            Op::Subtract => b.saturating_sub(*f),
        };
    }
}

/// The coverage a polygon takes in a `width` x `height` grid, mapped from
/// document pixels through `inverse` (cut's primitive): 255 on every pixel
/// whose centre is inside (even-odd, so a self-crossing lasso leaves the
/// overlap out), and 128 on a feathered contribution's ring beside this
/// polygon's own outside. The grid's own edge is never a feather, so a
/// rectangle erased to the panel edge leaves no faint line.
fn poly_coverage(
    points: &[[f32; 2]],
    feather: bool,
    (width, height): (u32, u32),
    inverse: &Transform,
) -> Result<Vec<u8>, String> {
    if points.len() < 3 || points.iter().flatten().any(|v| !v.is_finite()) {
        return Err("a selection needs at least three finite points".to_string());
    }
    let mut local: Vec<Point> = points.iter().map(|&[x, y]| Point::from_xy(x, y)).collect();
    inverse.map_points(&mut local);
    let len = width as usize * height as usize;
    let mut inside = vec![false; len];
    for (y, row) in spans(&local, width, height).into_iter().enumerate() {
        for (start, end) in row {
            for x in start..end {
                inside[y * width as usize + x as usize] = true;
            }
        }
    }
    let mut coverage = vec![0u8; len];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let i = y * width as usize + x;
            if !inside[i] {
                continue;
            }
            let edge = (x > 0 && !inside[i - 1])
                || (x + 1 < width as usize && !inside[i + 1])
                || (y > 0 && !inside[i - width as usize])
                || (y + 1 < height as usize && !inside[i + width as usize]);
            coverage[i] = if edge && feather { FEATHER } else { INSIDE };
        }
    }
    Ok(coverage)
}

/// True when two placements are the same (the common flows): a wand fill
/// applied to its own layer, or a preview on an unplaced layer.
fn same_placement(a: &LayerTransform, b: &LayerTransform) -> bool {
    a.x == b.x && a.y == b.y && a.scale_x == b.scale_x && a.scale_y == b.scale_y && a.rotation == b.rotation
}

/// The coverage a wand mask takes in a grid: its own bytes at its place when
/// the placements match, else its coverage sampled at each grid pixel's
/// mapped centre of the source grid.
fn mask_coverage(
    bytes: &[u8],
    (mask_x, mask_y, mask_width, mask_height): (i32, i32, u32, u32),
    source: &LayerTransform,
    grid: &LayerTransform,
    grid_inverse: &Transform,
    (width, height): (u32, u32),
) -> Result<Vec<u8>, String> {
    let mut laid = vec![0u8; width as usize * height as usize];
    if mask_width == 0 || mask_height == 0 {
        return Ok(laid);
    }
    if same_placement(source, grid) {
        for row in 0..mask_height {
            let y = i64::from(mask_y) + i64::from(row);
            if y < 0 || y >= i64::from(height) {
                continue;
            }
            for column in 0..mask_width {
                let x = i64::from(mask_x) + i64::from(column);
                if x < 0 || x >= i64::from(width) {
                    continue;
                }
                laid[(y * i64::from(width) + x) as usize] = bytes[(row * mask_width + column) as usize];
            }
        }
        return Ok(laid);
    }
    // tiny-skia's inverse of a zero scale is an infinity, not a refusal, so a
    // degenerate source grid is refused before the transform is built.
    if source.scale_x == 0.0 || source.scale_y == 0.0 {
        return Err("a wand fill's layer is scaled to nothing, so it cannot be composed".to_string());
    }
    let forward = transform_of(source)?;
    let source_inverse = forward
        .invert()
        .ok_or_else(|| "a wand fill's layer is scaled to nothing, so it cannot be composed".to_string())?;
    let grid_forward = transform_of(grid)?;
    // Only the mask's own box, drawn into the document then into this grid,
    // can take coverage: iterate that box, clipped to the grid.
    let (mask_right, mask_bottom) =
        (mask_x as i64 + i64::from(mask_width), mask_y as i64 + i64::from(mask_height));
    let mut corners = [
        Point::from_xy(mask_x as f32, mask_y as f32),
        Point::from_xy(mask_right as f32, mask_y as f32),
        Point::from_xy(mask_right as f32, mask_bottom as f32),
        Point::from_xy(mask_x as f32, mask_bottom as f32),
    ];
    forward.map_points(&mut corners);
    grid_inverse.map_points(&mut corners);
    let left = corners.iter().map(|p| p.x).fold(f32::MAX, f32::min).floor().clamp(0.0, width as f32) as u32;
    let top = corners.iter().map(|p| p.y).fold(f32::MAX, f32::min).floor().clamp(0.0, height as f32) as u32;
    let right = corners.iter().map(|p| p.x).fold(f32::MIN, f32::max).ceil().clamp(0.0, width as f32) as u32;
    let bottom = corners.iter().map(|p| p.y).fold(f32::MIN, f32::max).ceil().clamp(0.0, height as f32) as u32;
    if right <= left || bottom <= top {
        return Ok(laid); // the mask's box misses this grid entirely
    }
    let mut centre = vec![Point::from_xy(0.0, 0.0); (right - left) as usize];
    for y in top..bottom {
        for (column, point) in centre.iter_mut().enumerate() {
            *point = Point::from_xy((left + column as u32) as f32 + 0.5, y as f32 + 0.5);
        }
        grid_forward.map_points(&mut centre);
        source_inverse.map_points(&mut centre);
        for (column, point) in centre.iter().enumerate() {
            let x = (left + column as u32) as i64;
            let (u, v) = (i64::from(point.x.floor() as i32), i64::from(point.y.floor() as i32));
            if u < i64::from(mask_x) || v < i64::from(mask_y) {
                continue;
            }
            let (cu, cv) = ((u - i64::from(mask_x)) as usize, (v - i64::from(mask_y)) as usize);
            if cu >= mask_width as usize || cv >= mask_height as usize {
                continue;
            }
            laid[y as usize * width as usize + x as usize] = bytes[cv * mask_width as usize + cu];
        }
    }
    Ok(laid)
}

/// The mask of a coverage grid, cropped to its covered bounds; a zero-sized
/// mask when nothing is covered (the webview reads that as "clear").
fn cropped(coverage: Vec<u8>, width: u32, height: u32) -> WandMask {
    let (mut left, mut top, mut right, mut bottom) = (width, height, 0u32, 0u32);
    for (i, covered) in coverage.iter().enumerate() {
        if *covered == 0 {
            continue;
        }
        let (x, y) = ((i % width as usize) as u32, (i / width as usize) as u32);
        left = left.min(x);
        right = right.max(x + 1);
        top = top.min(y);
        bottom = bottom.max(y + 1);
    }
    if right == 0 {
        return WandMask { x: 0, y: 0, width: 0, height: 0, coverage: Vec::new() };
    }
    let (w, h) = (right - left, bottom - top);
    let mut mask = Vec::with_capacity(w as usize * h as usize);
    for row in 0..h {
        let from = ((top + row) * width + left) as usize;
        mask.extend_from_slice(&coverage[from..from + w as usize]);
    }
    WandMask { x: left as i32, y: top as i32, width: w, height: h, coverage: mask }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(transform: LayerTransform, contributions: Vec<Contribution>) -> ComposeMeta {
        ComposeMeta { width: 6, height: 4, transform, contributions }
    }

    fn poly(op: Op, feather: bool, points: Vec<[f32; 2]>) -> Contribution {
        Contribution::Poly { op, feather, points }
    }

    fn mask(op: Op, x: i32, y: i32, width: u32, height: u32, transform: LayerTransform) -> Contribution {
        Contribution::Mask { op, x, y, width, height, transform }
    }

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<[f32; 2]> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    fn cover(mask: &WandMask, x: u32, y: u32) -> u8 {
        mask.coverage[(y * mask.width + x) as usize]
    }

    #[test]
    fn a_polygon_on_a_placed_grid_takes_its_whole_pixels() {
        // The grid sits at (10, 20); document x 12..15, y 21..23 is grid x 2..5, y 1..3.
        let placed = LayerTransform { x: 10.0, y: 20.0, ..LayerTransform::IDENTITY };
        let out = compose(&meta(placed, vec![poly(Op::Add, false, rect(12.0, 21.0, 15.0, 23.0))]), &[]).unwrap();
        assert_eq!((out.x, out.y, out.width, out.height), (2, 1, 3, 2));
        assert!(out.coverage.iter().all(|c| *c == INSIDE));
        // A scaled grid: scale 2 puts document x 4..8, y 0..4 on grid x 2..4, y 0..2.
        let scaled = LayerTransform { scale_x: 2.0, scale_y: 2.0, ..LayerTransform::IDENTITY };
        let out = compose(&meta(scaled, vec![poly(Op::Add, false, rect(4.0, 0.0, 8.0, 4.0))]), &[]).unwrap();
        assert_eq!((out.x, out.y, out.width, out.height), (2, 0, 2, 2));
    }

    #[test]
    fn a_feathered_polygon_rings_its_boundary_but_not_the_grid_edge() {
        // Grid 6x4 at (10, 20); the polygon covers grid x 2..5, y 1..3.
        let placed = LayerTransform { x: 10.0, y: 20.0, ..LayerTransform::IDENTITY };
        let out = compose(&meta(placed, vec![poly(Op::Add, true, rect(12.0, 21.0, 15.0, 23.0))]), &[]).unwrap();
        for y in 0..2u32 {
            for x in 0..3u32 {
                assert_eq!(cover(&out, x, y), FEATHER, "the boundary feathers at ({x},{y})");
            }
        }
        // A full-grid polygon keeps every pixel fully covered: the grid's edge is not a feather.
        let out = compose(&meta(LayerTransform::IDENTITY, vec![poly(Op::Add, true, rect(0.0, 0.0, 6.0, 4.0))]), &[]).unwrap();
        assert_eq!((out.x, out.y, out.width, out.height), (0, 0, 6, 4));
        assert!(out.coverage.iter().all(|c| *c == INSIDE), "the grid's own edge stays fully covered");
        // A rectangle drawn to the grid's left edge feathers only its inner side:
        // x 0 has no neighbour to its left, but x 1 sees x 2 outside.
        let out = compose(&meta(LayerTransform::IDENTITY, vec![poly(Op::Add, true, rect(0.0, 0.0, 2.0, 4.0))]), &[]).unwrap();
        assert_eq!(cover(&out, 0, 0), INSIDE, "the grid's edge pixel keeps full coverage");
        assert_eq!(cover(&out, 1, 0), FEATHER, "x 1's neighbour to the right is outside");
    }

    #[test]
    fn an_unfeathered_polygon_stays_hard_throughout() {
        let placed = LayerTransform { x: 10.0, y: 20.0, ..LayerTransform::IDENTITY };
        let out = compose(&meta(placed, vec![poly(Op::Add, false, rect(12.0, 21.0, 15.0, 23.0))]), &[]).unwrap();
        assert!(out.coverage.iter().all(|c| *c == INSIDE), "no half-covered ring with the feather off");
    }

    #[test]
    fn subtracting_a_selection_empties_it_into_a_zero_sized_mask() {
        let contributions = vec![
            poly(Op::Add, false, rect(0.0, 0.0, 6.0, 4.0)),
            poly(Op::Subtract, false, rect(0.0, 0.0, 6.0, 4.0)),
        ];
        let out = compose(&meta(LayerTransform::IDENTITY, contributions), &[]).unwrap();
        assert_eq!(out, WandMask { x: 0, y: 0, width: 0, height: 0, coverage: Vec::new() });
        assert_eq!(out.to_frame(), vec![0; 16], "a zero-size frame clears the selection");
        // Removing half of the coverage leaves exactly the other half.
        let contributions = vec![
            poly(Op::Add, false, rect(0.0, 0.0, 6.0, 4.0)),
            poly(Op::Subtract, false, rect(0.0, 0.0, 3.0, 4.0)),
        ];
        let out = compose(&meta(LayerTransform::IDENTITY, contributions), &[]).unwrap();
        assert_eq!((out.x, out.width), (3, 3));
    }

    #[test]
    fn a_mask_at_a_matching_placement_is_an_exact_copy() {
        let out = compose(
            &ComposeMeta {
                width: 5,
                height: 3,
                transform: LayerTransform::IDENTITY,
                contributions: vec![mask(Op::Add, 1, 1, 2, 1, LayerTransform::IDENTITY)],
            },
            &[255, 128],
        )
        .unwrap();
        assert_eq!(out, WandMask { x: 1, y: 1, width: 2, height: 1, coverage: vec![255, 128] });
        // The fold is the wand's: adding keeps the stronger byte, subtracting removes it outright.
        let contributions = vec![mask(Op::Add, 1, 1, 2, 1, LayerTransform::IDENTITY), mask(Op::Subtract, 2, 1, 1, 1, LayerTransform::IDENTITY)];
        let out = compose(
            &ComposeMeta { width: 5, height: 3, transform: LayerTransform::IDENTITY, contributions },
            &[255, 128, 255],
        )
        .unwrap();
        // The emptied trailing pixel is cropped away.
        assert_eq!((out.x, out.width, &out.coverage[..]), (1, 1, &[255u8][..]));
        // Subtracting a weaker byte leaves the difference.
        let contributions = vec![mask(Op::Add, 1, 1, 1, 1, LayerTransform::IDENTITY), mask(Op::Subtract, 1, 1, 1, 1, LayerTransform::IDENTITY)];
        let out = compose(
            &ComposeMeta { width: 5, height: 3, transform: LayerTransform::IDENTITY, contributions },
            &[255, 128],
        )
        .unwrap();
        assert_eq!(out.coverage, vec![127]);
    }

    #[test]
    fn a_mask_across_a_scaled_grid_samples_the_mapped_pixel_centres() {
        // A 4x1 grid at scale 2: grid pixel x's centre is document 2x + 1.
        // The source (unplaced) mask covers its pixel x 5 only.
        let contributions = vec![mask(Op::Add, 5, 0, 1, 1, LayerTransform::IDENTITY)];
        let out = compose(
            &ComposeMeta {
                width: 4,
                height: 1,
                transform: LayerTransform { scale_x: 2.0, scale_y: 1.0, ..LayerTransform::IDENTITY },
                contributions,
            },
            &[255],
        )
        .unwrap();
        assert_eq!((out.x, out.width), (2, 1), "grid x 2's centre lands on source pixel 5");
        assert_eq!(out.coverage, vec![255]);
        // A feathered byte keeps its strength through the sample.
        let contributions = vec![mask(Op::Add, 5, 0, 1, 1, LayerTransform::IDENTITY)];
        let out = compose(
            &ComposeMeta {
                width: 4,
                height: 1,
                transform: LayerTransform { scale_x: 2.0, scale_y: 1.0, ..LayerTransform::IDENTITY },
                contributions,
            },
            &[FEATHER],
        )
        .unwrap();
        assert_eq!(out.coverage, vec![FEATHER]);
    }

    #[test]
    fn degenerate_polygons_and_transforms_are_refused() {
        let two = compose(&meta(LayerTransform::IDENTITY, vec![poly(Op::Add, false, vec![[0.0, 0.0], [1.0, 1.0]])]), &[]);
        assert_eq!(two.unwrap_err(), "a selection needs at least three finite points");
        let nan = compose(&meta(LayerTransform::IDENTITY, vec![poly(Op::Add, false, vec![[0.0, 0.0], [f32::NAN, 1.0], [1.0, 0.0]])]), &[]);
        assert_eq!(nan.unwrap_err(), "a selection needs at least three finite points");
        let flat = LayerTransform { scale_x: 0.0, ..LayerTransform::IDENTITY };
        let out = compose(&meta(flat, vec![poly(Op::Add, false, rect(0.0, 0.0, 1.0, 1.0))]), &[]);
        assert_eq!(out.unwrap_err(), "the layer is scaled to nothing, so it cannot be cut");
        let empty = compose(&ComposeMeta { width: 0, height: 4, transform: LayerTransform::IDENTITY, contributions: vec![] }, &[]);
        assert!(empty.is_err());
    }

    #[test]
    fn a_stack_cannot_start_by_subtracting_and_the_body_must_fit() {
        let out = compose(&meta(LayerTransform::IDENTITY, vec![poly(Op::Subtract, false, rect(0.0, 0.0, 2.0, 2.0))]), &[]);
        assert_eq!(out.unwrap_err(), SUBTRACT_FIRST);
        let contributions = vec![mask(Op::Add, 0, 0, 2, 1, LayerTransform::IDENTITY), mask(Op::Add, 1, 0, 1, 1, LayerTransform::IDENTITY)];
        let meta = meta(LayerTransform::IDENTITY, contributions);
        assert_eq!(compose(&meta, &[255, 255]).unwrap_err(), "the request body is shorter than the selection's masks");
        assert_eq!(compose(&meta, &[255, 255, 255, 255]).unwrap_err(), "the request body is longer than the selection's masks");
        assert_eq!(compose(&meta, &[255, 255, 255]).unwrap().coverage, vec![255, 255]);
    }

    #[test]
    fn meta_json_carries_the_grid_and_the_tagged_contributions() {
        let meta: ComposeMeta = serde_json::from_str(
            r#"{"width":6,"height":4,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "contributions":[
                  {"kind":"poly","op":"add","feather":true,"points":[[0,0],[6,0],[6,4]]},
                  {"kind":"mask","op":"subtract","x":1,"y":2,"width":2,"height":1,
                   "transform":{"x":10,"y":20,"scaleX":2,"scaleY":2,"rotation":0}}]}"#,
        )
        .unwrap();
        assert_eq!((meta.width, meta.height), (6, 4));
        assert_eq!(meta.contributions.len(), 2);
        match &meta.contributions[0] {
            Contribution::Poly { op, feather, points } => {
                assert_eq!(*op, Op::Add);
                assert!(*feather);
                assert_eq!(points.len(), 3);
            }
            other => panic!("expected a polygon, got {other:?}"),
        }
        match &meta.contributions[1] {
            Contribution::Mask { op, x, y, width, height, transform } => {
                assert_eq!(*op, Op::Subtract);
                assert_eq!((*x, *y, *width, *height), (1, 2, 2, 1));
                assert_eq!(transform.scale_x, 2.0);
            }
            other => panic!("expected a mask, got {other:?}"),
        }
        // A polygon's feather defaults off when the request omits it.
        let hard: ComposeMeta = serde_json::from_str(
            r#"{"width":2,"height":2,"transform":{"x":0,"y":0,"scaleX":1,"scaleY":1,"rotation":0},
                "contributions":[{"kind":"poly","op":"add","points":[[0,0],[2,0],[2,2]]}]}"#,
        )
        .unwrap();
        assert!(matches!(hard.contributions[0], Contribution::Poly { feather: false, .. }));
    }
}
