{
  pkgs ?
    import <nixpkgs> {
      config.allowUnfree = true;
    },
}:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    nodejs_24
    pnpm
    ffmpeg
    git
    gnumake
    typescript
    nil
    alejandra
    jq
    docker
    docker-compose
    # Pre-commit tools
    pre-commit
    python3Packages.pre-commit-hooks
    python3Packages.detect-secrets
    hadolint
    shellcheck
    nodePackages.markdownlint-cli
    # Video/audio processing tools
    libsodium
    pkg-config
    python3
    # For native modules compilation
    gcc
    nodePackages.node-gyp
    # ZeroMQ dependencies
    zeromq
    # Additional media tools
    yt-dlp
    mediainfo
  ];

  # Environment variables
  shellHook = ''
    echo "🚀 Discord Video Stream Bot Development Environment"
    echo "Node.js version: $(node --version)"
    echo "pnpm version: $(pnpm --version)"
    echo "TypeScript version: $(tsc --version)"
    echo "FFmpeg version: $(ffmpeg -version | head -n 1)"
    echo "Pre-commit version: $(pre-commit --version)"
    echo ""
    echo "📦 Installing dependencies..."
    if [ ! -d "node_modules" ]; then
      pnpm install
    fi
    echo ""
    echo "🔧 Setting up pre-commit hooks..."
    if [ ! -f ".git/hooks/pre-commit" ]; then
      pre-commit install
      pre-commit install --hook-type commit-msg
      echo "✅ Pre-commit hooks installed"
    else
      echo "✅ Pre-commit hooks already installed"
    fi
    echo ""
    echo "🎬 Ready for Discord video streaming development!"
    echo ""
    echo "Available commands:"
    echo "  pnpm dev         - Build and run the bot in development mode"
    echo "  pnpm build       - Build the TypeScript project"
    echo "  pnpm start       - Run the compiled bot"
    echo "  pnpm lint        - Run linting"
    echo "  pnpm format      - Format code with Biome"
    echo "  pnpm type-check  - Check TypeScript types"
    echo "  pre-commit run --all-files - Run all pre-commit hooks"
    echo "  git cz           - Commit with conventional commit format"
    echo ""
    echo "📝 Don't forget to copy config.example.json to config.json and configure it!"
    echo "🔒 Pre-commit hooks will automatically run on git commits"
  '';

  # Ensure native modules can be built
  PKG_CONFIG_PATH = "${pkgs.libsodium.dev}/lib/pkgconfig:${pkgs.zeromq}/lib/pkgconfig";
  SODIUM_NATIVE_STATIC = "1";
}
