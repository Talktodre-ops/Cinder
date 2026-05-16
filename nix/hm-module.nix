# Home Manager module for Cinder
# Usage in flake-based Home Manager config:
#
#   inputs.cinder.url = "github:talktodre-ops/Cinder";
#
#   { inputs, ... }: {
#     imports = [ inputs.cinder.homeManagerModules.default ];
#     programs.cinder.enable = true;
#   }
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.cinder;
in
{
  options.programs.cinder = {
    enable = lib.mkEnableOption "Cinder screen recorder";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.cinder;
      defaultText = lib.literalExpression "inputs.cinder.packages.\${pkgs.stdenv.hostPlatform.system}.cinder";
      description = "The Cinder package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
