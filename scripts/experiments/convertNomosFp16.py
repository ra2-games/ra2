"""Convert verified Nomos ONNX to FP16; keep the final rearrangement in FP32 for WASM compatibility."""
import argparse
import hashlib
from pathlib import Path
import onnx
from onnxconverter_common import float16

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
if args.output.exists():
    parser.error("输出已存在，拒绝覆盖")
source = onnx.load(args.source)
onnx.checker.check_model(source)
for values in (source.graph.input, source.graph.output):
    if len(values) != 1:
        raise ValueError("Expected one RGB input and output")
    tensor = values[0].type.tensor_type
    dims = tensor.shape.dim
    if tensor.elem_type != onnx.TensorProto.FLOAT or len(dims) != 4 or dims[0].dim_value != 1 or dims[1].dim_value != 3:
        raise ValueError("Expected FP32 NCHW RGB tensors")
graph = float16.convert_float_to_float16(source, keep_io_types=False,
    op_block_list=[*float16.DEFAULT_OP_BLOCK_LIST, "DepthToSpace"])
onnx.checker.check_model(graph)
args.output.parent.mkdir(parents=True, exist_ok=True)
onnx.save(graph, args.output)
print("SHA256", hashlib.sha256(args.output.read_bytes()).hexdigest())
print("bytes", args.output.stat().st_size)
