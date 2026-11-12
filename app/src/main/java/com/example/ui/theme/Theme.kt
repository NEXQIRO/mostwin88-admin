package com.example.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColorScheme = darkColorScheme(
    primary = GoldPrimary,
    onPrimary = OnGold,
    primaryContainer = BgInner,
    onPrimaryContainer = GoldPrimary,
    secondary = GoldBorder,
    onSecondary = OnGold,
    background = BgBase,
    onBackground = TextMain,
    surface = BgSurface,
    onSurface = TextMain,
    surfaceVariant = BgCard,
    onSurfaceVariant = TextMuted,
    outline = GoldBorder,
    outlineVariant = GoldLineSubtle,
    error = AccentRed,
    onError = Color.White
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFFD97706),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFF6F2E8),
    onPrimaryContainer = Color(0xFF1C1917),
    secondary = Color(0xFFB45309),
    onSecondary = Color.White,
    background = Color(0xFFF4F1EA),
    onBackground = Color(0xFF1C1917),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1C1917),
    surfaceVariant = Color(0xFFFAF6EC),
    onSurfaceVariant = Color(0xFF57534E),
    outline = Color(0xFFD97706),
    outlineVariant = Color(0xFFE6DECB),
    error = Color(0xFFDC2626),
    onError = Color.White
)

@Composable
fun Mostwin88AdminTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
