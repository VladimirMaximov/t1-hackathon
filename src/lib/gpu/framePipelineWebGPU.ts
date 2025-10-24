// src/lib/gpu/framePipelineWebGPU.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

function dbg(...args: any[]) {
    console.log("[WebGPUFrame]", ...args);
}

/**
 * Минимальный пайплайн WebGPU:
 * - копируем HTMLVideoElement → frameTex (rgba8unorm, COPY_DST | TEXTURE_BINDING)
 * - шейдер семплит frameTex и рисует в канву (RENDER_ATTACHMENT)
 * - поддержка зеркала (flipX)
 */
export class WebGPUFramePipeline {
    private adapter!: GPUAdapter;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private format!: GPUTextureFormat;

    private sampler!: GPUSampler;
    private pipeline!: GPURenderPipeline;
    private bindLayout!: GPUBindGroupLayout;
    private bindGroup!: GPUBindGroup;

    private uniformBuf!: GPUBuffer;                 // [flipX, _, _, _]
    private uniforms = new Uint32Array([1, 0, 0, 0]);

    private frameTex!: GPUTexture;                  // видео-кадр
    private w: number; private h: number;

    private cfgW = 0; private cfgH = 0;            // чтобы пере-конфигурировать контекст при ресайзе

    // fallback: OffscreenCanvas → ImageBitmap (на случай странностей copyExternalImageToTexture(video))
    private offscreen?: OffscreenCanvas;
    private off2d?: OffscreenCanvasRenderingContext2D | null;

    private constructor(canvas: HTMLCanvasElement, w: number, h: number) {
        this.w = w; this.h = h;
        // @ts-ignore
        this.context = canvas.getContext("webgpu") as GPUCanvasContext;
        if (!this.context) throw new Error("WebGPU canvas context not available");
        dbg("ctor: canvas acquired, target size:", w, "x", h);
    }

    static async create(canvas: HTMLCanvasElement, w: number, h: number) {
        if (!("gpu" in navigator)) throw new Error("navigator.gpu unsupported");
        const inst = new WebGPUFramePipeline(canvas, w, h);
        await inst.init();
        return inst;
    }

    render(video: HTMLVideoElement, flipX = true) {
        this.ensureConfigured();

        this.uniforms[0] = flipX ? 1 : 0;
        this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniforms);

        // 1) копируем кадр в нашу внутреннюю текстуру
        let copied = false;
        try {
            this.device.queue.copyExternalImageToTexture(
                { source: video, flipY: true },
                { texture: this.frameTex },
                { width: this.w, height: this.h }
            );
            copied = true;
        } catch (err: any) {
            console.warn("[WebGPUFrame] copyExternalImageToTexture(video→frameTex) failed:", err?.message ?? err);
            try {
                if (!this.offscreen) {
                    this.offscreen = new OffscreenCanvas(this.w, this.h);
                    this.off2d = this.offscreen.getContext("2d");
                    dbg("created OffscreenCanvas fallback", this.w, "x", this.h);
                }
                const ctx = this.off2d!;
                ctx.drawImage(video, 0, 0, this.w, this.h);
                const bmp = this.offscreen.transferToImageBitmap();
                this.device.queue.copyExternalImageToTexture(
                    { source: bmp, flipY: true },
                    { texture: this.frameTex },
                    { width: this.w, height: this.h }
                );
                bmp.close();
                copied = true;
                dbg("fallback path (OffscreenCanvas→ImageBitmap) used");
            } catch (err2: any) {
                console.warn("[WebGPUFrame] fallback copy failed:", err2?.message ?? err2);
            }
        }

        // 2) рендерим full-screen triangle в канву
        const view = this.context.getCurrentTexture().createView();
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view,
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
        this.device.queue.submit([enc.finish()]);

        if (!copied) {
            // Если копирование не получилось — покажется просто черный кадр.
            // Обычно fallback срабатывает и кадр виден.
        }
    }

    // ---------- private ----------
    private async init() {
        // @ts-ignore
        this.adapter = await (navigator as any).gpu.requestAdapter();
        if (!this.adapter) throw new Error("No WebGPU adapter");
        this.device = await this.adapter.requestDevice();
        dbg("init: device ready");

        // @ts-ignore
        this.format = (navigator as any).gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "premultiplied",
            usage: GPUTextureUsage.RENDER_ATTACHMENT // канва — только как рендер-цель
        });
        const c = this.context.canvas as HTMLCanvasElement;
        this.cfgW = c.width; this.cfgH = c.height;
        dbg("context configured:", { format: this.format, width: this.cfgW, height: this.cfgH });

        this.sampler = this.device.createSampler({
            label: "sampLinear",
            magFilter: "linear", minFilter: "linear",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"
        });

        this.frameTex = this.device.createTexture({
            label: "frameTex",
            size: { width: this.w, height: this.h },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        dbg("frameTex created:", this.w, "x", this.h);

        this.uniformBuf = this.device.createBuffer({
            size: 16, // 4 * u32 (16 байт выравнивание)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniforms);

        const shader = this.device.createShaderModule({ code: WGSL });

        this.bindLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // frame
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ]
        });

        const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] });

        this.pipeline = this.device.createRenderPipeline({
            layout,
            vertex: { module: shader, entryPoint: "vs_main" },
            fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
            primitive: { topology: "triangle-list" }
        });

        this.rebuildBindGroup();
        dbg("init: pipeline+bindGroup ready");
    }

    private rebuildBindGroup() {
        this.bindGroup = this.device.createBindGroup({
            layout: this.bindLayout,
            entries: [
                { binding: 0, resource: this.sampler },
                { binding: 1, resource: this.frameTex.createView() },
                { binding: 2, resource: { buffer: this.uniformBuf } },
            ]
        });
    }

    private ensureConfigured() {
        const c = this.context.canvas as HTMLCanvasElement;
        if (c.width !== this.cfgW || c.height !== this.cfgH) {
            dbg("ensureConfigured: canvas resized, reconfigure swapchain", { newW: c.width, newH: c.height });
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: "premultiplied",
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            });
            this.cfgW = c.width; this.cfgH = c.height;
        }
    }
}

const WGSL = /* wgsl */`
struct Uniforms {
  flipX:  u32,
  _u1:    u32,
  _u2:    u32,
  _u3:    u32,
};
@group(0) @binding(2) var<uniform> U: Uniforms;

@group(0) @binding(0) var samp     : sampler;
@group(0) @binding(1) var texFrame : texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  // Канонический fullscreen triangle
  var pos = array<vec2<f32>,3>(
    vec2(-1.0,-1.0), vec2( 3.0,-1.0), vec2(-1.0, 3.0)
  );
  var uv  = array<vec2<f32>,3>(
    vec2( 0.0, 0.0), vec2( 2.0, 0.0), vec2( 0.0, 2.0)
  );
  var o:VSOut;
  o.pos = vec4(pos[vid],0.0,1.0);
  o.uv  = uv[vid];
  return o;
}

@fragment
fn fs_main(i:VSOut) -> @location(0) vec4<f32> {
  var uv = i.uv;
  if (U.flipX==1u) { uv.x = 1.0 - uv.x; }
  let fg = textureSample(texFrame, samp, uv);
  return vec4(fg.rgb, 1.0);
}
`;
