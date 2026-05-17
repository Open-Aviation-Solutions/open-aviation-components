// Bakes two corrections into aircraft.glb so it displays correctly with no
// model-rotation or model-offset attributes:
//   1. 90° Y rotation  (nose was along wrong axis)
//   2. Y offset        (cancels the component's hardcoded obj.position.y += 0.1)
import { NodeIO } from '@gltf-transform/core';

const INPUT  = 'docs/public/aircraft.glb';
const OUTPUT = 'docs/public/aircraft.glb';

// --- quaternion helpers ---

function qMul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw*bx + ax*bw + ay*bz - az*by,
    aw*by - ax*bz + ay*bw + az*bx,
    aw*bz + ax*by - ay*bx + az*bw,
    aw*bw - ax*bx - ay*by - az*bz,
  ];
}

// --- matrix helpers (column-major, Three.js convention) ---

function mat4TRS([tx, ty, tz], [qx, qy, qz, qw], [sx, sy, sz]) {
  const x2=qx+qx, y2=qy+qy, z2=qz+qz;
  const xx=qx*x2, xy=qx*y2, xz=qx*z2;
  const yy=qy*y2, yz=qy*z2, zz=qz*z2;
  const wx=qw*x2, wy=qw*y2, wz=qw*z2;
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,     (xz-wy)*sx,     0,
    (xy-wz)*sy,     (1-(xx+zz))*sy, (yz+wx)*sy,     0,
    (xz+wy)*sz,     (yz-wx)*sz,     (1-(xx+yy))*sz, 0,
    tx, ty, tz, 1,
  ];
}

function mat4Mul(a, b) {
  const r = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        r[col*4+row] += a[k*4+row] * b[col*4+k];
  return r;
}

function transformPoint([x, y, z], m) {
  return [
    m[0]*x + m[4]*y + m[8]*z  + m[12],
    m[1]*x + m[5]*y + m[9]*z  + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

// --- world-space bounding box ---

function computeWorldBounds(document) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  function traverse(node, parentMat) {
    const worldMat = mat4Mul(parentMat, mat4TRS(
      node.getTranslation(),
      node.getRotation(),
      node.getScale(),
    ));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const buf = [];
        for (let i = 0; i < pos.getCount(); i++) {
          const w = transformPoint(pos.getElement(i, buf), worldMat);
          for (let j = 0; j < 3; j++) {
            if (w[j] < min[j]) min[j] = w[j];
            if (w[j] > max[j]) max[j] = w[j];
          }
        }
      }
    }
    for (const child of node.listChildren()) traverse(child, worldMat);
  }

  for (const scene of document.getRoot().listScenes())
    for (const node of scene.listChildren())
      traverse(node, IDENTITY);

  return { min, max };
}

// --- main ---

const io = new NodeIO();
const document = await io.read(INPUT);
const scene = document.getRoot().listScenes()[0];

// 1. Bake 90° Y rotation (pre-multiply = parent-group left-multiply)
const s = Math.sin(Math.PI / 4);
const c = Math.cos(Math.PI / 4);
const yRot90 = [0, s, 0, c];
for (const node of scene.listChildren())
  node.setRotation(qMul(yRot90, node.getRotation()));

// 2. Compute world-space bounds to determine the Three.js scale factor
const { min, max } = computeWorldBounds(document);
const size = max.map((v, i) => v - min[i]);
const maxDim = Math.max(...size);
const scale = 2.0 / maxDim;
console.log(`bounds size: [${size.map(v => v.toFixed(3))}]  maxDim: ${maxDim.toFixed(3)}  scale: ${scale.toFixed(4)}`);

// 3. Cancel the component's hardcoded obj.position.y += 0.1 (world space)
//    by translating root nodes down by 0.1/scale in model space.
const yOffset = -0.1 / scale;
console.log(`applying Y offset: ${yOffset.toFixed(4)} in model space`);
for (const node of scene.listChildren()) {
  const [tx, ty, tz] = node.getTranslation();
  node.setTranslation([tx, ty + yOffset, tz]);
}

await io.write(OUTPUT, document);
console.log(`wrote ${OUTPUT}`);
