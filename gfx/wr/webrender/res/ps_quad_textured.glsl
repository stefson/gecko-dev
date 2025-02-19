/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include ps_quad

#ifdef WR_VERTEX_SHADER
void main(void) {
    ps_quad_main();
}
#endif

#ifdef WR_FRAGMENT_SHADER
void main(void) {
    vec4 color = v_color;

#ifndef SWGL_ANTIALIAS
    if (v_flags.x != 0) {
        float alpha = init_transform_fs(vLocalPos);
        color *= alpha;
    }
#endif

    oFragColor = color;
}

#if defined(SWGL_DRAW_SPAN)
void swgl_drawSpanRGBA8() {
    swgl_commitSolidRGBA8(v_color);
}

void swgl_drawSpanR8() {
    swgl_commitSolidR8(v_color.x);
}
#endif

#endif
