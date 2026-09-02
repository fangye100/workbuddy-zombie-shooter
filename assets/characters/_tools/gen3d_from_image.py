# -*- coding: utf-8 -*-
"""
从本地概念图生成 3D 模型（混元 3D），并下载产物到本地目录。

用途
----
官方脚本 buddy-cloud.py 的 --image-base64 是命令行参数，而本地 PNG 转 base64 后
通常有 2-3 MB，远超 Windows 命令行长度上限（约 32K 字符），无法通过 CLI 传递。
本脚本直接 import buddy-cloud.py 作为模块，复用它的签名 / 提交 / 轮询实现，
把图片 base64 从文件读入，从而绕开该限制。

用法
----
  BUDDY_CLOUD_TOKEN=<token> python gen3d_from_image.py \
      --image "D:/path/to/E-04_front.png" \
      --outdir "D:/path/to/models/E-04" \
      --tag E04

Token 通过 stdin 管道传入（--token-stdin），不出现在命令行 / 进程列表里。
"""

import argparse
import base64
import importlib.util
import json
import os
import sys
import time
import urllib.parse

BUDDY_CLOUD = r"C:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\skills\buddy-multimodal-generation\scripts\buddy-cloud.py"


def load_buddy():
    """把 buddy-cloud.py 作为模块加载（文件名含连字符，不能用普通 import）。"""
    spec = importlib.util.spec_from_file_location("buddy_cloud", BUDDY_CLOUD)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["buddy_cloud"] = mod
    spec.loader.exec_module(mod)
    return mod


def download(url: str, dest: str) -> bool:
    """下载远程文件到本地。"""
    import requests

    try:
        resp = requests.get(url, stream=True, timeout=300)
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
        size = os.path.getsize(dest)
        print(f"[OK] {os.path.basename(dest)}  ({size / 1024 / 1024:.2f} MB)", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[WARN] 下载失败 {url}: {e}", file=sys.stderr)
        return False


def unzip_to(zip_path: str, dest_dir: str) -> list:
    """解压 zip 到目标目录，返回解压出的文件列表。"""
    import zipfile

    os.makedirs(dest_dir, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(dest_dir)
            names = zf.namelist()
        print(f"[OK] 解压 {len(names)} 个文件 -> {dest_dir}", file=sys.stderr)
        return [os.path.join(dest_dir, n) for n in names]
    except Exception as e:
        print(f"[WARN] 解压失败 {zip_path}: {e}", file=sys.stderr)
        return []


def ext_from_url(url: str, fallback: str) -> str:
    """从 URL 推断扩展名。"""
    path = urllib.parse.urlparse(url).path
    ext = os.path.splitext(path)[1].lower()
    return ext if ext else fallback


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=None, help="本地概念图路径（配合 --job-id 时不需要）")
    ap.add_argument("--outdir", required=True, help="产物输出目录")
    ap.add_argument("--tag", default="model", help="文件名前缀")
    ap.add_argument("--prompt", default="", help="可选的补充文本描述")
    ap.add_argument("--model", default="3.1", choices=["3.0", "3.1"])
    ap.add_argument("--face-count", type=int, default=80000)
    ap.add_argument("--generate-type", default="Normal",
                    choices=["Normal", "LowPoly", "Geometry", "Sketch"])
    ap.add_argument("--result-format", default="FBX", help="额外输出格式：STL/USDZ/FBX")
    ap.add_argument("--no-pbr", action="store_true", help="关闭 PBR 材质生成")
    ap.add_argument("--poll-interval", type=int, default=5)
    ap.add_argument("--max-poll-time", type=int, default=600)
    ap.add_argument("--token-stdin", action="store_true",
                    help="从 stdin 读取凭证（推荐，不暴露于进程列表）")
    ap.add_argument("--job-id", default=None,
                    help="只查询并下载已完成任务，不重新提交（避免重复消耗额度）")
    args = ap.parse_args()

    if args.token_stdin:
        token = sys.stdin.readline().strip()
    else:
        token = os.environ.get("BUDDY_CLOUD_TOKEN", "").strip()
    if not token:
        print("[FATAL] 缺少凭证：请用 --token-stdin 或设置环境变量 BUDDY_CLOUD_TOKEN",
              file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)

    buddy = load_buddy()
    buddy._ACTIVE_TOKEN = token  # 启用输出脱敏
    cfg = buddy._PROVIDER_MAP["3d"]

    if args.job_id:
        # 直接查询已完成任务并下载，不重新提交（避免重复消耗额度）
        print(f"[INFO] 查询已有任务 {args.job_id} ...", file=sys.stderr)
        result = buddy._call_api(
            buddy._DEFAULT_ENDPOINT, cfg["provider"], cfg["service"], cfg["version"],
            cfg["query_action"], {"JobId": args.job_id}, token,
        )
        job_id = args.job_id
        status = result.get("Status", "")
        if status != "DONE":
            print(f"[FATAL] 任务 {job_id} 状态为 {status}，尚未完成", file=sys.stderr)
            buddy._safe_print_json(result)
            sys.exit(1)
    else:
        if not args.image or not os.path.isfile(args.image):
            print(f"[FATAL] 图片不存在或未指定: {args.image}", file=sys.stderr)
            sys.exit(1)

        # 读取图片并转 base64
        with open(args.image, "rb") as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode("ascii")
        print(f"[INFO] 图片 {os.path.basename(args.image)}  "
              f"{len(raw) / 1024 / 1024:.2f} MB -> base64 {len(b64) / 1024 / 1024:.2f} MB",
              file=sys.stderr)
        if len(b64) > 6 * 1024 * 1024:
            print("[FATAL] base64 超过 6MB 上限，请先压缩图片", file=sys.stderr)
            sys.exit(1)

        body = buddy._build_3d_body(
            prompt=args.prompt,
            model=args.model,
            image_base64=b64,
            enable_pbr=not args.no_pbr,
            face_count=args.face_count,
            generate_type=args.generate_type,
            result_format=args.result_format,
        )

        print(f"[INFO] 提交 3D 生成任务 (model={args.model}, pbr={not args.no_pbr}, "
              f"faces={args.face_count}, type={args.generate_type}) ...", file=sys.stderr)

        submit = buddy._call_api(
            buddy._DEFAULT_ENDPOINT, cfg["provider"], cfg["service"], cfg["version"],
            cfg["submit_action"], body, token,
        )

        job_id = submit.get("JobId")
        if not job_id:
            print("[FATAL] 提交未返回 JobId", file=sys.stderr)
            buddy._safe_print_json(submit)
            sys.exit(1)

        print(f"[INFO] JobId = {job_id}", file=sys.stderr)

        result = buddy._poll_job(
            buddy._DEFAULT_ENDPOINT, cfg["provider"], cfg["service"], cfg["version"],
            cfg["query_action"], job_id, token,
            args.poll_interval, args.max_poll_time,
        )

    # 收集产物 URL。
    # 实际返回结构是 ResultFile3Ds（大写 Type / Url / PreviewImageUrl），
    # 历史/其他版本可能是 ResultFiles，这里都兼容。
    files = result.get("ResultFile3Ds") or result.get("ResultFiles") or []
    if not files:
        for key in ("ResultUrl", "ResultModelUrl", "ModelUrl"):
            val = result.get(key)
            if val:
                urls = val if isinstance(val, list) else [val]
                files = [{"Type": ext_from_url(u, ".glb").lstrip("."), "Url": u} for u in urls]
                break

    stamp = time.strftime("%Y%m%d_%H%M%S")
    downloaded = []
    seen_previews = set()

    for item in files:
        url = item.get("Url") or item.get("url")
        if not url:
            continue
        ftype = (item.get("Type") or item.get("type") or "").lower()
        ext = ext_from_url(url, "." + ftype if ftype else ".glb")

        # OBJ 产物实际是一个 zip 包，解压到独立子目录
        if ext == ".zip":
            zip_dest = os.path.join(args.outdir, f"{args.tag}_{stamp}_{ftype or 'obj'}.zip")
            if download(url, zip_dest):
                extracted = unzip_to(zip_dest, os.path.join(args.outdir, f"{ftype or 'obj'}_{stamp}"))
                downloaded.append({"path": zip_dest, "type": ftype or "obj", "url": url,
                                   "extracted": extracted})
        else:
            dest = os.path.join(args.outdir, f"{args.tag}_{stamp}{ext}")
            if download(url, dest):
                downloaded.append({"path": dest, "type": ftype or ext.lstrip("."), "url": url})

        preview = item.get("PreviewImageUrl") or item.get("preview_image_url")
        if preview and preview not in seen_previews:
            seen_previews.add(preview)
            pdest = os.path.join(args.outdir, f"{args.tag}_{stamp}_preview.png")
            if download(preview, pdest):
                downloaded.append({"path": pdest, "type": "preview", "url": preview})

    out = {
        "job_id": job_id,
        "status": result.get("Status", "DONE"),
        "source_image": args.image,
        "output_dir": args.outdir,
        "files": downloaded,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))

    if not downloaded:
        print("[FATAL] 没有任何产物下载成功", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
