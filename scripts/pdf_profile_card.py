#!/usr/bin/env python3
"""
pdf_profile_card.py  <input.json> <output.pdf>
Generates a student profile data card PDF.
"""
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))
from pdf_header import make_doc, mm
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle, HRFlowable, Image
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import mm as mm_unit

PROFILE_DIR = os.path.join(os.path.dirname(__file__), '../public/profile_uploads')

def run(input_path, output_path):
    with open(input_path) as f:
        data = json.load(f)

    doc = make_doc(output_path)
    student  = data['student']
    enrolled = data.get('enrolled', [])
    lb_hist  = data.get('lbHistory', [])

    h1     = ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=13, textColor=colors.HexColor('#0070C0'), spaceAfter=6)
    h2     = ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=10, textColor=colors.HexColor('#3730a3'), spaceAfter=4)
    normal = ParagraphStyle('n',  fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#334155'))
    label  = ParagraphStyle('lbl',fontName='Helvetica-Bold', fontSize=8, textColor=colors.grey)
    cell_s = ParagraphStyle('cs', fontName='Helvetica', fontSize=8)
    hdr_s  = ParagraphStyle('hs', fontName='Helvetica-Bold', fontSize=8, textColor=colors.white)

    story = []

    story.append(Paragraph('STUDENT PROFILE DATA CARD', h1))

    # Profile photo + info
    pic = os.path.join(PROFILE_DIR, student.get('profile_pic') or 'default_avatar.png')
    if not os.path.exists(pic):
        pic = os.path.join(PROFILE_DIR, 'default_avatar.png')
    try:
        photo = Image(pic, width=30*mm_unit, height=30*mm_unit)
    except:
        photo = Paragraph('(No photo)', normal)

    info = Table([
        [Paragraph('Full Name:', label), Paragraph(f"{student.get('last_name')}, {student.get('first_name')} {student.get('middle_name') or ''}", normal)],
        [Paragraph('LRN:', label), Paragraph(str(student.get('lrn_number') or '—'), normal)],
        [Paragraph('Sex:', label), Paragraph(str(student.get('sex') or '—'), normal)],
        [Paragraph('Strand:', label), Paragraph(str(student.get('strand') or '—'), normal)],
        [Paragraph('Current Level:', label), Paragraph(str(student.get('current_level') or '1'), normal)],
        [Paragraph('Total EXP:', label), Paragraph(str(student.get('total_exp') or 0), normal)],
    ], colWidths=[28*mm_unit, 90*mm_unit])
    info.setStyle(TableStyle([('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),2)]))

    outer = Table([[info, photo]], colWidths=[130*mm_unit, 35*mm_unit])
    outer.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP')]))
    story.append(outer)
    story.append(Spacer(1, 5*mm_unit))
    story.append(HRFlowable(width='100%', thickness=0.6, color=colors.HexColor('#6366f1')))
    story.append(Spacer(1, 5*mm_unit))

    # Enrolled classes
    story.append(Paragraph('Enrolled Classes', h2))
    if enrolled:
        enr_rows = [[Paragraph('Class', hdr_s), Paragraph('Subject', hdr_s), Paragraph('School Year', hdr_s)]]
        for e in enrolled:
            enr_rows.append([Paragraph(e.get('class_name',''), cell_s), Paragraph(e.get('subject_name',''), cell_s), Paragraph(e.get('school_year',''), cell_s)])
        et = Table(enr_rows, colWidths=[60*mm_unit, 80*mm_unit, 40*mm_unit], repeatRows=1)
        et.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0), colors.HexColor('#3730a3')),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f8faff')]),
            ('GRID',(0,0),(-1,-1),0.4, colors.HexColor('#e2e8f0')),
            ('FONTSIZE',(0,0),(-1,-1),8),
            ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
        ]))
        story.append(et)
    else:
        story.append(Paragraph('No enrollment records.', normal))

    story.append(Spacer(1, 5*mm_unit))

    # Leaderboard history
    story.append(Paragraph('Leaderboard History (Last 20)', h2))
    if lb_hist:
        lb_rows = [[Paragraph('Date', hdr_s), Paragraph('Subject', hdr_s), Paragraph('Rank', hdr_s), Paragraph('EXP Snapshot', hdr_s)]]
        for l in lb_hist:
            lb_rows.append([
                Paragraph(str(l.get('recorded_at',''))[:10], cell_s),
                Paragraph(l.get('subject_name',''), cell_s),
                Paragraph(f"#{l.get('rank_achieved','')}", cell_s),
                Paragraph(str(l.get('total_exp_snapshot','')), cell_s),
            ])
        lt = Table(lb_rows, colWidths=[30*mm_unit, 80*mm_unit, 20*mm_unit, 40*mm_unit], repeatRows=1)
        lt.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0), colors.HexColor('#1e3a5f')),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f8faff')]),
            ('GRID',(0,0),(-1,-1),0.4, colors.HexColor('#e2e8f0')),
            ('FONTSIZE',(0,0),(-1,-1),8),
            ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
        ]))
        story.append(lt)
    else:
        story.append(Paragraph('No leaderboard history yet.', normal))

    doc.build(story)
    print(f'[OK] Written: {output_path}')

if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2])