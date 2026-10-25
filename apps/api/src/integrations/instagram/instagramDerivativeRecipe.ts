import sharp from "sharp";
import { InstagramClientError } from "./types";

/**
 * The Instagram derivative recipe on its own (sharp only, no storage/database imports), so the confined preparation
 * worker can render it without loading the API's repositories. Output-affecting changes require a new recipe ID;
 * existing definitions stay immutable.
 */
export const imageRecipes = Object.freeze({
  "instagram-v1": Object.freeze({ width: 1080, height: 1080 }),
  "instagram-portrait-v1": Object.freeze({ width: 1080, height: 1350 }),
});
export type InstagramImageRecipe = keyof typeof imageRecipes;
const invalid = () => new InstagramClientError("invalid_media", false);

/**
 * The W11 recipe: one immutable JPEG derivative of a single-frame WebP source (shared by every W11 writer). The body is
 * main's original in-file recipe, only moved here; like it, it does not assert admission itself. Every production
 * importer runs it under image admission (asserted by fencing-disposition.test.cjs and instagramRecipeAdmission.test.ts).
 */
export async function renderInstagramDerivative(source: Buffer, recipeId: InstagramImageRecipe): Promise<Buffer> {
  const recipe = imageRecipes[recipeId];
  const image = sharp(source, { failOn: "error", limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== "webp" || (metadata.pages ?? 1) !== 1) throw invalid();
  // Contain preserves the entire image and its proportions, including extreme ratios.
  const bytes = await image.rotate().resize(recipe.width, recipe.height, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" }).toColourspace("srgb").jpeg({ quality: 90 }).toBuffer();
  if (bytes.length > 8 * 1024 * 1024) throw invalid();
  return bytes;
}
