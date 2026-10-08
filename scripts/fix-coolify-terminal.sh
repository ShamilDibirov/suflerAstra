#!/usr/bin/env bash
# Backport the container picker fix from coollabsio/coolify@f412e7063493.
# Run on the Coolify host. Patches only two panel files, with backups.
set -euo pipefail
panel_container="${1:-coolify}"
docker exec -i "$panel_container" php <<'PHP'
<?php
$root = '/var/www/html';
$controller = $root . '/app/Livewire/Project/Shared/ExecuteContainerCommand.php';
$view = $root . '/resources/views/livewire/project/shared/execute-container-command.blade.php';
$originalController = @file_get_contents($controller);
$originalView = @file_get_contents($view);
if ($originalController === false || $originalView === false) {
    fwrite(STDERR, "Coolify source files not found. No changes made.\n");
    exit(1);
}
if (str_contains($originalController, 'public array $containerOptions = [];') &&
    str_contains($originalView, "containerOptions: @entangle('containerOptions')")) {
    echo "Official container picker fix is already installed. No changes made.\n";
    exit(0);
}
$propertyAnchor = '    protected $rules = [';
$sortAnchor = <<<'CODE'
        $this->containers = $this->containers->sortBy(function ($container) {
            return data_get($container, 'container.Names');
        });
CODE;
$oldOptions = <<<'CODE'
        $containerOptions = $containers->map(fn ($container) => [
            'value' => data_get($container, 'server.uuid').':'.data_get($container, 'container.Names'),
            'label' => data_get($container, 'container.Names').' · '.data_get($container, 'server.name'),
        ])->values();
CODE;
$oldBinding = 'containerOptions: @js($containerOptions),';
foreach ([[$originalController, $propertyAnchor], [$originalController, $sortAnchor],
          [$originalView, $oldOptions], [$originalView, $oldBinding]] as [$source, $anchor]) {
    if (substr_count($source, $anchor) !== 1) {
        fwrite(STDERR, "Installed Coolify differs from the supported revision. No changes made.\n");
        exit(1);
    }
}
if (str_contains($originalController, 'public array $containerOptions')) {
    fwrite(STDERR, "Partially applied or different fix detected. No changes made.\n");
    exit(1);
}
$controllerText = str_replace($propertyAnchor, '    public array $containerOptions = [];' . "\n\n" . $propertyAnchor, $originalController);
$newOptions = <<<'CODE'

        $this->containerOptions = $this->containers->map(fn (array $container) => [
            'value' => data_get($container, 'server.uuid').':'.data_get($container, 'container.Names'),
            'label' => data_get($container, 'container.Names').' · '.data_get($container, 'server.name'),
        ])->values()->all();
CODE;
$controllerText = str_replace($sortAnchor, $sortAnchor . "\n" . $newOptions, $controllerText);
$viewText = str_replace($oldOptions . "\n", '', $originalView);
$viewText = str_replace($oldBinding, "containerOptions: @entangle('containerOptions'),", $viewText);
$temp = tempnam(sys_get_temp_dir(), 'coolify-terminal-');
file_put_contents($temp, $controllerText);
exec(escapeshellarg(PHP_BINARY) . ' -l ' . escapeshellarg($temp) . ' 2>&1', $lintOutput, $lintStatus);
unlink($temp);
if ($lintStatus !== 0) {
    fwrite(STDERR, "PHP syntax check failed. No changes made.\n");
    exit(1);
}
$suffix = '.before-terminal-fix-' . gmdate('Ymd-His');
if (!copy($controller, $controller . $suffix) || !copy($view, $view . $suffix)) {
    fwrite(STDERR, "Cannot create backups. No source changes made.\n");
    exit(1);
}
if (file_put_contents($controller, $controllerText) === false || file_put_contents($view, $viewText) === false) {
    file_put_contents($controller, $originalController);
    file_put_contents($view, $originalView);
    fwrite(STDERR, "Write failed; original files restored.\n");
    exit(1);
}
echo "Container picker patched. Backups:\n$controller$suffix\n$view$suffix\n";
PHP
docker exec -w /var/www/html "$panel_container" php artisan view:clear
echo 'Reload the Coolify application Terminal page with Cmd+Shift+R.'
echo 'This panel-only fix will be replaced by the next Coolify image update.'
