<?php

use Illuminate\Support\Facades\Route;
use Plugin\NodeAddressSwitch\Controllers\NodeController;

Route::prefix('api/v1/node-address-switch')->middleware('throttle:60,1')->group(function () {
    Route::get('nodes', [NodeController::class, 'nodes']);
    Route::post('switch', [NodeController::class, 'switchHosts']);
    Route::post('visibility', [NodeController::class, 'switchVisibility']);
});
