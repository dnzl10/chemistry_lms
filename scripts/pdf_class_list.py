#!/usr/bin/env python3
"""
pdf_class_list.py  <input.json> <output.pdf>
Generates a class list PDF — one page per class, with Mabini header.
"""
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))
from pdf_header import make_doc, PAGE_W, MARGIN, mm
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import mm as mm_unit

def run(input_path, output_path):
    with open(input_path) as f:
        data = json.load(f)

    doc    = make_doc(output_path)
    styles = getSampleStyleSheet()
    story  = []

    heading_style = ParagraphStyle('heading', fontName='Helvetica-Bold', fontSize=12, textColor=colors.HexColor('#1e3a5f'), spaceAfter=4)
    sub_style     = ParagraphStyle('sub',     fontName='Helvetica',      fontSize=9,  textColor=colors.grey, spaceAfter=8)
    cell_style    = ParagraphStyle('cell',    fontName='Helvetica',      fontSize=9,  textColor=colors.HexColor('#1e293b'))
    hdr_style     = ParagraphStyle('hdr',     fontName='Helvetica-Bold', fontSize=9,  textColor=colors.white)

    teacher = data.get('teacher', {})
    classes = data.get('classes', [])

    for i, cls in enumerate(classes):
        if i > 0:
            story.append(PageBreak())

        story.append(Paragraph(f"{cls['class_name']} — {cls['subject_name']}", heading_style))
        story.append(Paragraph(f"School Year: {cls.get('school_year','—')} &nbsp;&nbsp; Teacher: {teacher.get('first_name','')} {teacher.get('last_name','')}", sub_style))
        story.append(HRFlowable(width='100%', thickness=0.5, color=colors.HexColor('#e2e8f0'), spaceAfter=8))

        # Table
        col_widths = [15*mm_unit, 20*mm_unit, 70*mm_unit, 15*mm_unit, 30*mm_unit, 30*mm_unit]
        header_row = [
            Paragraph('#', hdr_style),
            Paragraph('LRN', hdr_style),
            Paragraph('Full Name', hdr_style),
            Paragraph('Sex', hdr_style),
            Paragraph('Strand', hdr_style),
            Paragraph('Section', hdr_style),
        ]
        rows = [header_row]
        for idx, s in enumerate(cls.get('students', [])):
            name = f"{s.get('last_name','')}, {s.get('first_name','')} {s.get('middle_name','') or ''}"
            rows.append([
                Paragraph(str(idx + 1), cell_style),
                Paragraph(str(s.get('lrn_number') or ''), cell_style),
                Paragraph(name.strip(), cell_style),
                Paragraph(str(s.get('sex') or ''), cell_style),
                Paragraph(str(s.get('strand') or ''), cell_style),
                Paragraph('', cell_style),  # section — blank for handwrite
            ])

        tbl = Table(rows, colWidths=col_widths, repeatRows=1)
        tbl.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e3a5f')),
            ('TEXTCOLOR',  (0,0), (-1,0), colors.white),
            ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
            ('FONTSIZE',   (0,0), (-1,-1), 9),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f8faff')]),
            ('GRID',       (0,0), (-1,-1), 0.4, colors.HexColor('#e2e8f0')),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ('LEFTPADDING',   (0,0), (-1,-1), 6),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 6*mm_unit))
        story.append(Paragraph(f"Total Students: <b>{len(cls.get('students',[]))}</b>", sub_style))

    doc.build(story)
    print(f'[OK] Written: {output_path}')

if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2])