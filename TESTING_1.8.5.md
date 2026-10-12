# 1.8.5 validation

Use the existing still-open Temporary Chat tab; do not refresh it if losing it is a concern. Install the unpacked extension, select Export full chat, and check message counts and actual response bodies. If scroller detection still fails, copy the text error containing `probe=`; it includes only offsets, not conversation content. No incomplete PDF should be produced. See tests/test_negative_scroll_185.py for synthetic reverse-scrollport regression coverage.
