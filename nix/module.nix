# NixOS module for Cinder
# Usage in flake-based NixOS config:
#
#   inputs.cinder.url = "github:talktodre-ops/Cinder";
#
#   { inputs, ... }: {
#     imports = [ inputs.cinder.nixosModules.default ];
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
    environment.systemPackages = [ cfg.package ];

    # Screen capture on Wayland requires xdg-desktop-portal.
    # We enable the base portal; users should also enable a
    # desktop-specific portal (e.g. xdg-desktop-portal-gtk,
    # xdg-desktop-portal-hyprland) in their DE config.
    xdg.portal.enable = lib.mkDefault true;
  };
}
