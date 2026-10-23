"""Copy an existing Windows executable's icon resources into an ICO container.

No pixels are modified. Used once for the user-requested Claude Desktop icon;
the bundled icon has its own third-party notice and is not a runtime dependency.
"""
import argparse
import hashlib
import struct
from pathlib import Path


def extract(exe):
    data = Path(exe).read_bytes()
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    if data[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Not a PE executable')
    sections, optional_size = struct.unpack_from('<H12xH', data, pe + 6)
    optional = pe + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    resource_rva = struct.unpack_from('<I', data, directories + 16)[0]

    def offset(rva):
        for i in range(sections):
            header = optional + optional_size + i * 40
            virtual_size, virtual, raw_size, raw = struct.unpack_from('<IIII', data, header + 8)
            if virtual <= rva < virtual + max(virtual_size, raw_size):
                return raw + rva - virtual
        raise ValueError('Resource outside image sections')

    base = offset(resource_rva)

    def entries(relative):
        position = base + relative
        named, ids = struct.unpack_from('<HH', data, position + 12)
        return [struct.unpack_from('<II', data, position + 16 + i * 8) for i in range(named + ids)]

    def payload(relative):
        while relative & 0x80000000:
            relative = entries(relative & 0x7FFFFFFF)[0][1]
        rva, size = struct.unpack_from('<II', data, base + relative)
        return data[offset(rva):offset(rva) + size]

    types = dict(entries(0))
    groups = [payload(entry) for _, entry in entries(types[14] & 0x7FFFFFFF)]
    group = max(groups, key=lambda raw: struct.unpack_from('<H', raw, 4)[0])
    reserved, kind, count = struct.unpack_from('<HHH', group)
    if reserved != 0 or kind != 1 or not count:
        raise ValueError('Invalid icon group')
    icons = dict(entries(types[3] & 0x7FFFFFFF))
    header = bytearray(struct.pack('<HHH', 0, 1, count))
    bodies = bytearray()
    for i in range(count):
        width, height, colors, reserved, planes, bits, size, identifier = struct.unpack_from('<BBBBHHIH', group, 6 + i * 14)
        image = payload(icons[identifier])
        if len(image) != size:
            raise ValueError('Icon resource size mismatch')
        header.extend(struct.pack('<BBBBHHII', width, height, colors, reserved, planes, bits, size, 6 + count * 16 + len(bodies)))
        bodies.extend(image)
    return bytes(header + bodies), count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    icon, count = extract(args.exe)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(icon)
    print('Icon images:', count)
    print('SHA256:', hashlib.sha256(icon).hexdigest())
