import { Request, Response } from 'express';
import cloudinary from '../config/cloudinary.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

// Adds automatic format + quality to a Cloudinary delivery URL
export const optimizeDeliveryUrl = (url: string): string => {
    if (!url || url.includes("/upload/f_auto,q_auto/")) return url;
    return url.replace("/upload/", "/upload/f_auto,q_auto/");
}

// True only if the URL really is hosted on *your* Cloudinary account
const isOwnCloudinaryUrl = (url: string): boolean => {
    const cloudName = cloudinary.config().cloud_name;
    try {
        const u = new URL(url);
        return !!cloudName && u.protocol === "https:" && u.hostname === "res.cloudinary.com"
            && u.pathname.startsWith(`/${cloudName}/image/upload/`);
    } catch {
        return false;
    }
}

const isHttpsUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

export function applyCloudinaryTransformations(
    url: string,
    action: "recolor" | "bg-remove",
    options: {prompt?: string; toColor?: string; multiple?: boolean} = {},
): string {
    // Only letters, numbers and spaces may reach the URL, so users can't inject extra transformations
    const prompt = (options.prompt || "").replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 100);
    const toColor = (options.toColor || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || "red";

    const transform = action === "bg-remove"
        ? "e_background_removal/f_auto,q_auto"
        : `e_gen_recolor:prompt_${encodeURIComponent(prompt)};to-color_${toColor}${options.multiple ? ";multiple_true" : ""}/f_auto,q_auto`;

    return url.replace("/image/upload/", `/image/upload/${transform}/`);
}

export const uploadToCloudinary = (
    fileBuffer: Buffer,
    folder: string = 'storeifly',
) : Promise<{ url: string; public_id: string }> => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder, resource_type: "image" },
            (error, result) => {
                if (error || !result) {
                    reject(error || new Error('Failed to upload image'));
                } else {
                    resolve({ url: optimizeDeliveryUrl(result.secure_url), public_id: result.public_id });
                }
            }
        );
        uploadStream.end(fileBuffer);
    });
}

// Upload single image to cloudinary
export const uploadSingle = async (req: Request, res: Response) => {
    try {
        if (!req.file) {
            return res.status(400).json({success: false, message: 'No file uploaded' });
        }

        const { url, public_id } = await uploadToCloudinary(req.file.buffer, 'storeifly');
        return res.status(200).json({ success: true, url, public_id });
    } catch (error) {
        console.error('Error uploading to Cloudinary:', error);
        return res.status(500).json({success: false, message: 'Failed to upload image' });
    }
}

// upload multiple images to cloudinary in parallel
export const uploadMultiple = async (req: Request, res: Response) => {
    try {
        const files = req.files as Express.Multer.File[] | undefined;
        if (!files || files.length === 0) {
            return res.status(400).json({success: false, message: 'No files uploaded' });
        }

        const images = await Promise.all(
            files.map((file) => uploadToCloudinary(file.buffer, 'storeifly'))
        );
        return res.status(200).json({ success: true, urls: images.map((i) => i.url), images });
    } catch (error) {
        console.error('Error uploading to Cloudinary:', error);
        return res.status(500).json({success: false, message: 'Failed to upload images' });
    }
}

// AI Transformation of images to cloudinary
export const aiTransform = async (req: Request, res: Response) => {
    try {
        const { imageUrl, action, prompt, toColor, multiple } = req.body ?? {};
        if (!isHttpsUrl(imageUrl)) {
            return res.status(400).json({success: false, message: 'A valid https imageUrl is required' });
        }
        if (action !== "recolor" && action !== "bg-remove") {
            return res.status(400).json({success: false, message: 'action must be "recolor" or "bg-remove"' });
        }
        if (action === "recolor" && !prompt) {
            return res.status(400).json({success: false, message: 'prompt is required for recolor' });
        }

        let baseCloudinaryUrl = imageUrl;

        // Ensure Image is hosted on Cloudinary
        if (!isOwnCloudinaryUrl(imageUrl)) {
            const uploadResult = await cloudinary.uploader.upload(imageUrl, {
                folder: 'storeifly/products',
                resource_type: 'image',
            });
            baseCloudinaryUrl = uploadResult.secure_url;
        }

        const transformedUrl = applyCloudinaryTransformations(baseCloudinaryUrl, action, {
            prompt, toColor, multiple: Boolean(multiple),
        });

        return res.status(200).json({ success: true, transformedUrl, originalUrl: baseCloudinaryUrl });
    } catch (error) {
        console.error('Error transforming image:', error);
        return res.status(500).json({success: false, message: 'Failed to transform image' });
    }
}

const ensureCloudinaryUrl = async (url: string, folder = 'storeifly/tryon'): Promise<string> => {
    if (isOwnCloudinaryUrl(url)) {
        return url;
    }
    const res = await cloudinary.uploader.upload(url, {
        folder,
        resource_type: 'image',
    }).catch((error) => {
        console.error('Error uploading to Cloudinary:', error);
        throw new Error('Failed to upload image to Cloudinary');
    });
    return res.secure_url;
}

export interface GenerateOnModelImageParams {
    prompt: string;
    productImageUrl: string;
    modelImage: string;
    targetPublicId: string;
    preference?: string;
}

export interface GenerateOnModelResult {
    secureUrl: string;
    publicId: string;
    model?: string;
    limits?: any;
}

export const generateOnModelImage = async (params: GenerateOnModelImageParams) :
Promise<GenerateOnModelResult> => {
    const { cloud_name, api_key, api_secret } = cloudinary.config();
    if (!cloud_name || !api_key || !api_secret) {
        throw new Error("Cloudinary instance credentials are not configured");
    }

    const payload = {
        prompt: params.prompt,
        reference_images: [
            { source_type: "url", url: params.modelImage },
            { source_type: "url", url: params.productImageUrl },
        ],
        model: { mode: "auto", ...(params.preference ? { preference: params.preference } : {}) },
        target: { target_type: "managed_asset", public_id: params.targetPublicId },
    };

    const response = await fetch(`https://api.cloudinary.com/v2/generate/${cloud_name}/image_to_image`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(`${api_key}:${api_secret}`).toString("base64")}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    const data: any = await response.json().catch(() => null);

    if (!response.ok || !data) {
        const err: any = new Error(data?.error?.message || data?.message || `Cloudinary API error (${response.status})`);
        err.status = response.status;
        err.details = data?.error;
        throw err;
    }

    const asset = data?.data?.assets?.[0] || data?.data?.result?.assets?.[0];
    const rawUrl = asset?.storage?.secure_url || asset?.secure_url || data?.secure_url;
    if (!rawUrl) throw new Error("No image URL returned from Cloudinary generation");

    return {
        secureUrl: optimizeDeliveryUrl(rawUrl),
        publicId: asset?.storage?.public_id || params.targetPublicId,
        model: asset?.model,
        limits: data?.limits,
    };
}

// controller endpoint for on-model catalog photography / virtual try-on
export const aiOnModel = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { productImageUrl, modelImage, customPrompt, preference } = req.body ?? {};

        if (!isHttpsUrl(productImageUrl) || !isHttpsUrl(modelImage)) {
            return res.status(400).json({success: false, message: 'Both productImageUrl and modelImage (https URLs) are required' });
        }
        if (customPrompt !== undefined && (typeof customPrompt !== "string" || customPrompt.length > 1000)) {
            return res.status(400).json({success: false, message: 'customPrompt must be text of 1000 characters or less' });
        }

        const [modelUrl, productUrl] = await Promise.all([
            ensureCloudinaryUrl(modelImage, 'storeifly/models'),
            ensureCloudinaryUrl(productImageUrl, 'storeifly/products'),
        ]);

        const prompt = customPrompt?.trim()
            ? customPrompt.includes("[1]") && customPrompt.includes("[2]")
                ? customPrompt.replace("[1]", productUrl).replace("[2]", modelUrl)
                : `${customPrompt} ${productUrl} ${modelUrl}`
            : `A high-quality image of a model wearing the product. Product image: ${productUrl}. Model image: ${modelUrl}.`;

        // Generated on the server so users can't overwrite other assets in your Cloudinary account
        const targetPublicId = `storeifly/tryon/${req.user!.id}/${Date.now()}`;

        const result = await generateOnModelImage({
            prompt,
            modelImage: modelUrl,
            productImageUrl: productUrl,
            targetPublicId,
            preference: typeof preference === "string" ? preference : undefined,
        });

        return res.status(200).json({
            success: true,
            url: result.secureUrl,
            public_id: result.publicId,
            model: result.model,
            prompt,
            modelUrl,
            productUrl,
            limits: result.limits,
        });
    } catch (error) {
        console.error('Error in on-model photography:', error);
        return res.status(500).json({success: false, message: 'Failed to process on-model photography' });
    }
}
