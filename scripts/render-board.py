"""Render the shared game's FEN as a Man Ray 1920 inspired wooden chess set.

Run with Blender 3.5 or later:
  blender --background --python scripts/render-board.py -- \
    --state game/state.json --output assets/chess-board.png

The six silhouettes follow the 1920 set, including its bottle bishop and
violin-scroll knight: https://www.metmuseum.org/art/collection/search/480922
Geometry, camera, lighting and sampling seed are fixed. No assets are fetched.
"""

import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector


CREAM = "f7f7f0"
BLUE = "0d01ff"
BOARD_TOP = 0.24


def linear(hex_color):
    """Convert design colors from sRGB to Blender's scene-linear values."""
    values = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
                 for v in values) + (1.0,)


def material(name, color, roughness=0.34):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = linear(color)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = linear(color)
    shader.inputs["Roughness"].default_value = roughness
    specular = shader.inputs.get("Specular IOR Level") or shader.inputs.get("Specular")
    if specular:
        specular.default_value = 0.28
    return mat


def finish(obj, mat, parent=None, smooth=False, bevel=0):
    obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    if bevel:
        # Blender 3.x needs this flag for weighted normals. Newer Blender
        # versions calculate split normals directly and omit the property.
        if hasattr(obj.data, "use_auto_smooth"):
            obj.data.use_auto_smooth = True
        modifier = obj.modifiers.new("Soft painted edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
        modifier.limit_method = "ANGLE"
        modifier = obj.modifiers.new("Face normals", "WEIGHTED_NORMAL")
        modifier.keep_sharp = True
    return obj


def box(name, location, size, mat, parent=None, bevel=0.01):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, parent, bevel=bevel)


def cone(name, radius1, radius2, depth, z, mat, parent, vertices=64):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1,
                                    radius2=radius2, depth=depth, location=(0, 0, z))
    obj = bpy.context.object
    obj.name = name
    finish(obj, mat, parent, smooth=True, bevel=0.009)
    for face in obj.data.polygons:
        if len(face.vertices) > 4:
            face.use_smooth = False
    return obj


def lathe(name, profile, mat, parent, segments=64):
    vertices = []
    for radius, z in profile:
        for i in range(segments):
            angle = i * math.tau / segments
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), z))
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(profile) - 1):
        for i in range(segments):
            a = row * segments + i
            b = row * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.append(tuple((len(profile) - 1) * segments + i for i in range(segments)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, mat, parent, smooth=True)
    obj.data.polygons[0].use_smooth = False
    obj.data.polygons[-1].use_smooth = False
    return obj


def bezier_points(start, segments):
    """Sample connected cubic curves, used for the carved scroll's outline."""
    points = [start]
    for first, second, end in segments:
        for step in range(1, 13):
            t = step / 12
            points.append(tuple((1 - t) ** 3 * start[i] + 3 * (1 - t) ** 2 * t * first[i]
                                + 3 * (1 - t) * t * t * second[i] + t ** 3 * end[i]
                                for i in (0, 1)))
        start = end
    return points


def scroll(mat, parent):
    # Solid violin finial with a diagonal cut at its foot, not a horse or ring.
    outline = bezier_points((-.24, 0.015), [
        ((-.43, .31), (-.39, .67), (-.15, .84)),
        ((.04, .99), (.31, .88), (.36, .66)),
        ((.42, .45), (.23, .27), (.075, .30)),
        ((.035, .305), (.005, .32), (-.015, .34)),
    ])
    outline += [(.28, .035), (.28, .015)]
    depth = .24
    vertices = [(x, y, z) for y in (-depth / 2, depth / 2) for x, z in outline]
    count = len(outline)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend((i, (i + 1) % count, (i + 1) % count + count, i + count)
                 for i in range(count))
    mesh = bpy.data.meshes.new("Violin finial silhouette")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Knight · carved scroll", mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, mat, parent, bevel=.015)

    # A low, continuous spiral relief on both cheeks catches the studio light.
    for side in (-1, 1):
        curve = bpy.data.curves.new("Scroll carving", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = 2
        curve.bevel_depth = .018
        curve.bevel_resolution = 3
        spline = curve.splines.new("POLY")
        count = 100
        spline.points.add(count - 1)
        for i, point in enumerate(spline.points):
            t = i / (count - 1)
            angle = -.5 * math.pi + t * math.tau * 1.38
            radius = .29 * (1 - t) + .018 * t
            point.co = (.055 + radius * math.cos(angle), side * (depth / 2 + .004),
                        .59 + radius * math.sin(angle), 1)
        obj = bpy.data.objects.new("Knight · spiral relief", curve)
        bpy.context.collection.objects.link(obj)
        obj.parent = parent
        obj.data.materials.append(mat)


def piece(kind, color, file, rank, mat):
    root = bpy.data.objects.new(f"{color} {kind} at {'abcdefgh'[file]}{rank + 1}", None)
    bpy.context.collection.objects.link(root)
    root.location = (file - 3.5, rank - 3.5, BOARD_TOP + .006)
    if kind == "p":
        cone("Pawn · small flared foot", .235, .17, .105, .0525, mat, root)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24,
                                           radius=.275, location=(0, 0, .34))
        finish(bpy.context.object, mat, root, smooth=True).name = "Pawn · sphere"
    elif kind == "r":
        box("Rook · cube", (0, 0, .315), (.63, .63, .63), mat, root, bevel=.012)
    elif kind == "q":
        cone("Queen · cone", .35, .013, 1.44, .72, mat, root)
    elif kind == "k":
        mesh = bpy.data.meshes.new("Square pyramid")
        mesh.from_pydata([(-.34, -.34, 0), (.34, -.34, 0), (.34, .34, 0),
                          (-.34, .34, 0), (0, 0, 1.4)], [],
                         [(3, 2, 1, 0), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)])
        mesh.update()
        obj = bpy.data.objects.new("King · pyramid", mesh)
        bpy.context.collection.objects.link(obj)
        finish(obj, mat, root, bevel=.007)
    elif kind == "b":
        lathe("Bishop · flagon", [
            (.225, 0), (.263, .02), (.29, .065), (.311, .13), (.319, .215),
            (.308, .295), (.28, .365), (.241, .43), (.196, .50), (.15, .59),
            (.112, .69), (.093, .78), (.091, .88), (.10, .96), (.132, 1.015),
            (.174, 1.035), (.175, 1.085), (.172, 1.10),
        ], mat, root)
    elif kind == "n":
        scroll(mat, root)
        # Face the broad carved side toward the viewer while opposing the armies.
        root.rotation_euler[2] = -.20 if color == "white" else math.pi - .20


def read_position(path):
    state = json.loads(path.read_text())
    fen = state.get("fen")
    if not isinstance(fen, str):
        raise ValueError("State must contain a FEN string")
    fields = fen.split()
    if len(fields) != 6 or fields[1] not in ("w", "b"):
        raise ValueError("State contains an invalid FEN")
    rows = fields[0].split("/")
    if len(rows) != 8:
        raise ValueError("FEN must contain eight ranks")
    pieces = []
    for row, notation in enumerate(rows):
        file = 0
        for value in notation:
            if value in "12345678":
                file += int(value)
            elif value in "prnbqkPRNBQK" and file < 8:
                pieces.append((value.lower(), "white" if value.isupper() else "blue", file, 7 - row))
                file += 1
            else:
                raise ValueError("FEN contains an invalid piece or file")
        if file != 8:
            raise ValueError("Each FEN rank must contain eight squares")
    return pieces


def label(text, location, mat):
    curve = bpy.data.curves.new("Coordinate", "FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = .145
    curve.extrude = 0
    obj = bpy.data.objects.new("Coordinate " + text, curve)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    curve.materials.append(mat)


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def area(name, location, power, size, target=(0, 0, 0)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)


def scene_setup(pieces, samples):
    # Ignore local startup scenes and rendering presets.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 1920
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = .035
    scene.cycles.max_bounces = 5
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 3
    scene.cycles.transparent_max_bounces = 4
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 70
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.world = bpy.data.worlds.new("Studio world")
    scene.world.use_nodes = True
    world = scene.world.node_tree.nodes.get("Background")
    world.inputs["Color"].default_value = (1, 1, 1, 1)
    world.inputs["Strength"].default_value = .32

    ivory = material("Warm ivory painted wood", "eee8d6", .30)
    blue = material("Electric blue painted wood", BLUE, .32)
    square_light = material("Ivory squares", "f5f3e7", .44)
    square_blue = material("Pale blue squares", "cbd3eb", .44)
    rim = material("Cream board edge", "e5e3d7", .40)
    lettering = material("Blue coordinates", "526092", .55)
    floor = material("Cream studio floor", CREAM, .7)

    box("Thin board plinth", (0, 0, .11), (8.52, 8.52, .22), rim, bevel=.055)
    for file in range(8):
        for rank in range(8):
            # a1 is a dark square.
            mat = square_blue if (file + rank) % 2 == 0 else square_light
            box(f"Square {'abcdefgh'[file]}{rank + 1}", (file - 3.5, rank - 3.5, .229),
                (.999, .999, .022), mat, bevel=0)
    for file in range(8):
        label("abcdefgh"[file], (file - 3.5, -4.12, .223), lettering)
    for rank in range(8):
        label(str(rank + 1), (-4.12, rank - 3.5, .223), lettering)
    for kind, color, file, rank in pieces:
        piece(kind, color, file, rank, ivory if color == "white" else blue)

    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.022))
    finish(bpy.context.object, floor).name = "Studio shadow catcher"
    bpy.context.object.is_shadow_catcher = True
    area("Large softbox", (-3.5, -4.5, 10), 450, 7)
    area("Soft side fill", (5, 1, 7), 180, 6)
    area("Back rim light", (-1, 6, 8), 250, 5)

    data = bpy.data.cameras.new("Studio camera")
    camera = bpy.data.objects.new("Studio camera", data)
    bpy.context.collection.objects.link(camera)
    camera.location = (8.8, -12.2, 17.8)
    aim(camera, (0, 0, .25))
    data.type = "ORTHO"
    data.ortho_scale = 14.0
    scene.camera = camera

    # Composite studio shadows over the exact #f7f7f0 profile cream.
    # Shadowed pixels vary naturally while the base color stays fixed.
    scene.use_nodes = True
    nodes = scene.node_tree.nodes
    nodes.clear()
    layers = nodes.new("CompositorNodeRLayers")
    background = nodes.new("CompositorNodeAlphaOver")
    background.inputs[0].default_value = 1
    background.inputs[1].default_value = linear(CREAM)
    scene.node_tree.links.new(layers.outputs["Image"], background.inputs[2])
    output = nodes.new("CompositorNodeComposite")
    scene.node_tree.links.new(background.outputs["Image"], output.inputs["Image"])
    return scene


def export_stl(path):
    """Write evaluated board geometry without requiring Blender's STL addon."""
    graph = bpy.context.evaluated_depsgraph_get()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".rendering")
    count = 0
    with temporary.open("wb") as output:
        output.write(b"Man Ray inspired shared chess board".ljust(80, b"\0"))
        output.write(struct.pack("<I", 0))
        for obj in bpy.context.scene.objects:
            if obj.type not in ("MESH", "CURVE") or obj.is_shadow_catcher:
                continue
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                mesh.calc_loop_triangles()
                for triangle in mesh.loop_triangles:
                    points = [obj.matrix_world @ mesh.vertices[i].co for i in triangle.vertices]
                    normal = (points[1] - points[0]).cross(points[2] - points[0]).normalized()
                    values = tuple(normal) + tuple(value for point in points for value in point)
                    output.write(struct.pack("<12fH", *values, 0))
                    count += 1
            finally:
                evaluated.to_mesh_clear()
        output.seek(80)
        output.write(struct.pack("<I", count))
    if temporary.stat().st_size >= 10_000_000:
        temporary.unlink()
        raise ValueError("STL exceeds GitHub's 10 MB viewer limit")
    temporary.replace(path)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("game/state.json"))
    parser.add_argument("--output", type=Path, default=Path("assets/chess-board.png"))
    parser.add_argument("--stl", type=Path, help="Optional binary STL for GitHub's 3D viewer")
    parser.add_argument("--samples", type=int, default=32)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if not 1 <= args.samples <= 256:
        parser.error("--samples must be between 1 and 256")
    position = read_position(args.state)
    scene = scene_setup(position, args.samples)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Render to a sibling first so failures leave the previous board intact.
    temporary = args.output.with_name(args.output.stem + ".rendering.png")
    scene.render.filepath = str(temporary.resolve())
    bpy.ops.render.render(write_still=True)
    temporary.replace(args.output)
    result = {"rendered": str(args.output), "pieces": len(position), "samples": args.samples}
    if args.stl:
        result.update(stl=str(args.stl), triangles=export_stl(args.stl))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
