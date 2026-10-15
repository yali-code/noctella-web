/* #390 DIAGNOSTIC: exercises every libvips 8.17.3 webpsave path touched by
 * vips-rgb-free.patch (single RGB/RGBA import, use_argb import, multi-pass
 * target_size, and animated frames that must keep their frame buffer).
 * Run once per libvips variant, normally and under valgrind; outputs of the
 * unmodified and patched variants must be byte-identical. Synthetic pixels only.
 */
#include <stdio.h>
#include <stdlib.h>
#include <vips/vips.h>

static int
save(VipsImage *in, const char *dir, const char *name, int which)
{
	void *buf = NULL;
	size_t len = 0;
	int result;

	switch (which) {
	case 0:
		result = vips_webpsave_buffer(in, &buf, &len, "Q", 86, "effort", 4, NULL);
		break;
	case 1:
		result = vips_webpsave_buffer(in, &buf, &len, "Q", 86, "effort", 4, "smart_subsample", TRUE, NULL);
		break;
	case 2:
		result = vips_webpsave_buffer(in, &buf, &len, "lossless", TRUE, "effort", 4, NULL);
		break;
	default:
		result = vips_webpsave_buffer(in, &buf, &len, "Q", 86, "effort", 4, "target_size", 40000, NULL);
		break;
	}
	if (result)
		return -1;

	char path[4096];
	snprintf(path, sizeof(path), "%s/%s.webp", dir, name);
	FILE *f = fopen(path, "wb");
	if (!f || fwrite(buf, 1, len, f) != len || fclose(f)) {
		g_free(buf);
		return -1;
	}
	g_free(buf);
	return 0;
}

int
main(int argc, char **argv)
{
	const int width = 1024, height = 768;
	unsigned char *rgb, *rgba;
	VipsImage *in3, *in4, *anim = NULL;

	if (argc != 2 || VIPS_INIT(argv[0]))
		return 2;

	rgb = g_malloc((size_t) width * height * 3);
	rgba = g_malloc((size_t) width * height * 4);
	for (int y = 0; y < height; y++)
		for (int x = 0; x < width; x++)
			for (int b = 0; b < 4; b++) {
				unsigned char v = (unsigned char) (x * 7 + y * 13 + b * 71 + (x * y) % 251);
				rgba[((size_t) y * width + x) * 4 + b] = b == 3 ? (unsigned char) (128 + (x + y) % 128) : v;
				if (b < 3)
					rgb[((size_t) y * width + x) * 3 + b] = v;
			}

	in3 = vips_image_new_from_memory(rgb, (size_t) width * height * 3, width, height, 3, VIPS_FORMAT_UCHAR);
	in4 = vips_image_new_from_memory(rgba, (size_t) width * height * 4, width, height, 4, VIPS_FORMAT_UCHAR);
	if (!in3 || !in4 || vips_copy(in3, &anim, NULL))
		vips_error_exit("synthetic input");
	vips_image_set_int(anim, "page-height", height / 4);

	if (save(in3, argv[1], "rgb-q86-e4", 0) ||
		save(in4, argv[1], "rgba-q86-e4", 0) ||
		save(in3, argv[1], "rgb-smart-subsample", 1) ||
		save(in3, argv[1], "rgb-lossless", 2) ||
		save(in3, argv[1], "rgb-target-size", 3) ||
		save(anim, argv[1], "anim-4-frames", 0))
		vips_error_exit("webpsave");

	g_object_unref(anim);
	g_object_unref(in4);
	g_object_unref(in3);
	g_free(rgba);
	g_free(rgb);
	vips_shutdown();
	return 0;
}
