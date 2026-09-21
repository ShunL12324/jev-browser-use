"""Deterministic, fictitious one-page PDFs; no third-party modules."""
from pathlib import Path
for seed in ['atlas', 'birch']:
    text = f'Synthetic resume - {seed} - fixture only. No real person.'
    stream = f'BT /F1 14 Tf 40 750 Td ({text}) Tj ET'
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream']
    data = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{i} 0 obj\n{obj}\nendobj\n'.encode()
    xref = len(data)
    data += b'xref\n0 6\n0000000000 65535 f \n'
    for offset in offsets[1:]:
        data += f'{offset:010d} 00000 n \n'.encode()
    data += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    Path(__file__).with_name(f'{seed}.pdf').write_bytes(data)
