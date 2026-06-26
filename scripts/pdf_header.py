# pdf_header.py — shared Mabini Colleges header for all exported PDFs
import os
from reportlab.lib.pagesizes import legal
from reportlab.lib import colors
from reportlab.platypus import Table, TableStyle, Paragraph, Spacer, HRFlowable
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame

ASSETS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'public', 'assets'))
LOGO_LEFT  = os.path.join(ASSETS_DIR, 'mabini_seal.gif')   # image1.gif
LOGO_RIGHT = os.path.join(ASSETS_DIR, 'mabini_logo2.png')  # image2.png

PAGE_W, PAGE_H = legal   # 8.5 x 13 inches
MARGIN = 12.7 * mm

def draw_header(canvas, doc):
    """Called on every page to draw the Mabini Colleges header."""
    canvas.saveState()
    y_top = PAGE_H - MARGIN
    logo_size = 18 * mm

    # Left logo
    if os.path.exists(LOGO_LEFT):
        canvas.drawImage(LOGO_LEFT, MARGIN, y_top - logo_size, width=logo_size, height=logo_size, preserveAspectRatio=True, mask='auto')

    # Right logo
    if os.path.exists(LOGO_RIGHT):
        canvas.drawImage(LOGO_RIGHT, PAGE_W - MARGIN - logo_size, y_top - logo_size, width=logo_size, height=logo_size, preserveAspectRatio=True, mask='auto')

    # Center text block
    cx = PAGE_W / 2
    canvas.setFont('Helvetica-Bold', 14)
    canvas.setFillColor(colors.HexColor('#0070C0'))
    canvas.drawCentredString(cx, y_top - 6*mm, 'MABINI COLLEGES, INC.')

    canvas.setFont('Helvetica-Bold', 11)
    canvas.setFillColor(colors.black)
    canvas.drawCentredString(cx, y_top - 11*mm, 'HIGH SCHOOL DEPARTMENT')

    canvas.setFont('Helvetica', 10)
    canvas.drawCentredString(cx, y_top - 15.5*mm, '(Flora A. Ibana Campus)')
    canvas.drawCentredString(cx, y_top - 19.5*mm, 'Kapt. Isko St., Daet, Camarines Norte')

    # Separator line below header
    canvas.setStrokeColor(colors.HexColor('#0070C0'))
    canvas.setLineWidth(1.2)
    canvas.line(MARGIN, y_top - 22*mm, PAGE_W - MARGIN, y_top - 22*mm)

    # Page number bottom
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.grey)
    canvas.drawCentredString(cx, MARGIN / 2, f'Page {doc.page}')

    canvas.restoreState()

HEADER_HEIGHT = 24 * mm  # space the header takes from top

def make_doc(output_path):
    """Create a BaseDocTemplate with the Mabini header on every page."""
    frame = Frame(
        MARGIN,
        MARGIN,
        PAGE_W - 2 * MARGIN,
        PAGE_H - 2 * MARGIN - HEADER_HEIGHT,
        id='main'
    )
    template = PageTemplate(id='mabini', frames=[frame], onPage=draw_header)
    doc = BaseDocTemplate(
        output_path,
        pagesize=legal,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN + HEADER_HEIGHT, bottomMargin=MARGIN
    )
    doc.addPageTemplates([template])
    return doc