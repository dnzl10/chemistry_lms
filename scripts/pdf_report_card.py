#!/usr/bin/env python3
"""
pdf_report_card.py  <input.json> <output.pdf>
Generates a student progress report card with optional graphs, answers, and photo.
"""
import sys, json, os, io
sys.path.insert(0, os.path.dirname(__file__))
from pdf_header import make_doc, PAGE_W, MARGIN, HEADER_HEIGHT, mm
from reportlab.platypus import (Paragraph, Spacer, Table, TableStyle,
                                 HRFlowable, Image, KeepTogether)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import mm as mm_unit
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics import renderPDF

PROFILE_DIR = os.path.join(os.path.dirname(__file__), '../public/profile_uploads')

def score_color(pct):
    if pct >= 75: return colors.HexColor('#10b981')
    if pct >= 50: return colors.HexColor('#f59e0b')
    return colors.HexColor('#ef4444')

def build_bar_chart(scores):
    """Build a simple bar chart of score % per assessment."""
    if not scores: return None
    labels = [s.get('assessment_name','')[:12] for s in scores]
    values = [round(s['score_obtained'] / s['total_possible_score'] * 100) if s.get('total_possible_score') else 0 for s in scores]
    d   = Drawing(440, 120)
    bc  = VerticalBarChart()
    bc.x, bc.y, bc.width, bc.height = 60, 10, 370, 100
    bc.data           = [values]
    bc.categoryAxis.categoryNames = labels
    bc.categoryAxis.labels.fontSize  = 7
    bc.categoryAxis.labels.angle     = 20
    bc.valueAxis.valueMin            = 0
    bc.valueAxis.valueMax            = 100
    bc.valueAxis.valueStep           = 25
    bc.bars[0].fillColor             = colors.HexColor('#6366f1')
    bc.bars[0].strokeColor           = None
    d.add(bc)
    return d

def run(input_path, output_path):
    with open(input_path) as f:
        data = json.load(f)

    doc     = make_doc(output_path)
    styles  = getSampleStyleSheet()
    student = data['student']
    scores  = data.get('scores', [])
    responses = data.get('responses', [])
    progress  = data.get('progress', [])
    incl_answers = data.get('incl_answers', True)
    incl_graph   = data.get('incl_graph', True)
    incl_photo   = data.get('incl_photo', True)

    h1 = ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=13, textColor=colors.HexColor('#1e3a5f'), spaceAfter=3)
    h2 = ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=10, textColor=colors.HexColor('#3730a3'), spaceAfter=3)
    normal = ParagraphStyle('n', fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#334155'))
    label  = ParagraphStyle('lbl', fontName='Helvetica-Bold', fontSize=8, textColor=colors.grey)
    cell_s = ParagraphStyle('cs', fontName='Helvetica', fontSize=8)
    hdr_s  = ParagraphStyle('hs', fontName='Helvetica-Bold', fontSize=8, textColor=colors.white)

    story = []

    # ── Student info block ──
    info_rows = [
        [Paragraph('STUDENT PROGRESS REPORT CARD', ParagraphStyle('title', fontName='Helvetica-Bold', fontSize=14, textColor=colors.HexColor('#0070C0')))],
    ]
    left_info = [
        [Paragraph('Full Name:', label), Paragraph(f"{student.get('last_name')}, {student.get('first_name')}", normal)],
        [Paragraph('LRN:', label), Paragraph(str(student.get('lrn_number') or '—'), normal)],
        [Paragraph('Level:', label), Paragraph(str(student.get('current_level') or '—'), normal)],
        [Paragraph('Total EXP:', label), Paragraph(str(student.get('total_exp') or 0), normal)],
        [Paragraph('Sex:', label), Paragraph(str(student.get('sex') or '—'), normal)],
        [Paragraph('Strand:', label), Paragraph(str(student.get('strand') or '—'), normal)],
    ]
    left_tbl = Table(left_info, colWidths=[25*mm_unit, 80*mm_unit])
    left_tbl.setStyle(TableStyle([('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),2)]))

    if incl_photo:
        pic = os.path.join(PROFILE_DIR, student.get('profile_pic') or 'default_avatar.png')
        if not os.path.exists(pic):
            pic = os.path.join(PROFILE_DIR, 'default_avatar.png')
        try:
            photo = Image(pic, width=28*mm_unit, height=28*mm_unit)
        except:
            photo = Paragraph('(No photo)', normal)
        info_outer = Table([[left_tbl, photo]], colWidths=[140*mm_unit, 35*mm_unit])
    else:
        info_outer = left_tbl

    story.append(Paragraph('STUDENT PROGRESS REPORT CARD', ParagraphStyle('title', fontName='Helvetica-Bold', fontSize=14, textColor=colors.HexColor('#0070C0'), spaceAfter=8)))
    story.append(info_outer)
    story.append(Spacer(1, 5*mm_unit))
    story.append(HRFlowable(width='100%', thickness=0.6, color=colors.HexColor('#6366f1')))
    story.append(Spacer(1, 5*mm_unit))

    # ── Score Graph ──
    if incl_graph and scores:
        story.append(Paragraph('Assessment Scores Overview', h2))
        chart = build_bar_chart(scores)
        if chart:
            story.append(chart)
            story.append(Spacer(1, 4*mm_unit))

    # ── Scores Table ──
    story.append(Paragraph('Assessment Results', h2))
    score_rows = [[
        Paragraph('Assessment', hdr_s), Paragraph('Type', hdr_s),
        Paragraph('Topic', hdr_s), Paragraph('Score', hdr_s),
        Paragraph('%', hdr_s), Paragraph('EXP', hdr_s), Paragraph('Date', hdr_s)
    ]]
    for s in scores:
        pct = round(s['score_obtained'] / s['total_possible_score'] * 100) if s.get('total_possible_score') else 0
        score_rows.append([
            Paragraph(s.get('assessment_name','')[:30], cell_s),
            Paragraph(s.get('assessment_type',''), cell_s),
            Paragraph(s.get('topic_name',''), cell_s),
            Paragraph(f"{s['score_obtained']}/{s['total_possible_score']}", cell_s),
            Paragraph(f"{pct}%", ParagraphStyle('pct', fontName='Helvetica-Bold', fontSize=8, textColor=score_color(pct))),
            Paragraph(str(s.get('exp_gained',0)), cell_s),
            Paragraph(str(s.get('date_recorded',''))[:10], cell_s),
        ])
    if not scores:
        score_rows.append([Paragraph('No assessment data', cell_s)] + [Paragraph('', cell_s)]*6)

    st = Table(score_rows, colWidths=[55*mm_unit,22*mm_unit,35*mm_unit,20*mm_unit,14*mm_unit,14*mm_unit,22*mm_unit], repeatRows=1)
    st.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0), colors.HexColor('#3730a3')),
        ('TEXTCOLOR',(0,0),(-1,0), colors.white),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f8faff')]),
        ('GRID',(0,0),(-1,-1),0.4, colors.HexColor('#e2e8f0')),
        ('FONTSIZE',(0,0),(-1,-1),8),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
    ]))
    story.append(st)
    story.append(Spacer(1, 6*mm_unit))

    # ── Per-question answers ──
    if incl_answers and responses:
        story.append(Paragraph('Detailed Answer Breakdown', h2))
        # Group by score_id
        from collections import defaultdict
        grouped = defaultdict(list)
        for r in responses:
            grouped[r['score_id']].append(r)
        score_map = {s['score_id']: s for s in scores}

        for sid, resps in grouped.items():
            sc = score_map.get(sid, {})
            story.append(Paragraph(f"<b>{sc.get('assessment_name','Assessment')}</b> — {sc.get('date_recorded','')}", normal))
            ans_rows = [[
                Paragraph('#', hdr_s), Paragraph('Question', hdr_s),
                Paragraph('Student Answer', hdr_s), Paragraph('Correct', hdr_s), Paragraph('Result', hdr_s)
            ]]
            for qi, r in enumerate(resps):
                result_color = colors.HexColor('#10b981') if r['is_correct'] else colors.HexColor('#ef4444')
                ans_rows.append([
                    Paragraph(str(qi+1), cell_s),
                    Paragraph((r.get('question_text') or '')[:50], cell_s),
                    Paragraph(str(r.get('selected_option') or '—'), cell_s),
                    Paragraph(str(r.get('correct_answer') or '—'), cell_s),
                    Paragraph('✓ Correct' if r['is_correct'] else '✕ Wrong',
                              ParagraphStyle('res', fontName='Helvetica-Bold', fontSize=8, textColor=result_color)),
                ])
            at = Table(ans_rows, colWidths=[10*mm_unit,80*mm_unit,30*mm_unit,30*mm_unit,22*mm_unit], repeatRows=1)
            at.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(-1,0), colors.HexColor('#1e3a5f')),
                ('TEXTCOLOR',(0,0),(-1,0), colors.white),
                ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f8faff')]),
                ('GRID',(0,0),(-1,-1),0.4, colors.HexColor('#e2e8f0')),
                ('FONTSIZE',(0,0),(-1,-1),8),
                ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
            ]))
            story.append(at)
            story.append(Spacer(1, 4*mm_unit))

    doc.build(story)
    print(f'[OK] Written: {output_path}')

if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2])