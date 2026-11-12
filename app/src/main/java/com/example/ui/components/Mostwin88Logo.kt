package com.example.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.ui.theme.GoldPrimary

@Composable
fun Mostwin88Logo(
    modifier: Modifier = Modifier,
    isSmall: Boolean = false
) {
    val infiniteTransition = rememberInfiniteTransition(label = "mostwin_logo_wheel")
    val wheelAngle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1440f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 6000
                0f at 0
                0f at 1500
                1440f at 4200 using FastOutSlowInEasing
                1440f at 6000
            },
            repeatMode = RepeatMode.Restart
        ),
        label = "wheel_angle"
    )

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "M",
                color = Color.White,
                fontSize = if (isSmall) 22.sp else 34.sp,
                fontWeight = FontWeight.Black
            )
            // Animated Roulette Wheel O
            Box(
                modifier = Modifier
                    .size(if (isSmall) 20.dp else 30.dp)
                    .padding(horizontal = 2.dp),
                contentAlignment = Alignment.Center
            ) {
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val radius = size.minDimension / 2f
                    val center = Offset(size.width / 2f, size.height / 2f)

                    // Rotating outer dashed ring
                    rotate(degrees = wheelAngle, pivot = center) {
                        drawCircle(
                            color = Color.White.copy(alpha = 0.4f),
                            radius = radius - 2f,
                            center = center,
                            style = Stroke(width = 4f)
                        )
                        drawCircle(
                            color = Color.White,
                            radius = radius - 2f,
                            center = center,
                            style = Stroke(
                                width = 4f,
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 4f), 0f)
                            )
                        )
                    }
                    // Inner gold core
                    drawCircle(
                        color = GoldPrimary,
                        radius = radius * 0.45f,
                        center = center
                    )
                    drawCircle(
                        color = Color(0xFFFFF2B3),
                        radius = radius * 0.45f,
                        center = center,
                        style = Stroke(width = 1.5f)
                    )
                }
            }
            Text(
                text = "ST",
                color = Color.White,
                fontSize = if (isSmall) 22.sp else 34.sp,
                fontWeight = FontWeight.Black
            )
            Text(
                text = "WIN",
                color = GoldPrimary,
                fontSize = if (isSmall) 22.sp else 34.sp,
                fontWeight = FontWeight.Black
            )
            Text(
                text = "88",
                color = Color.White,
                fontSize = if (isSmall) 22.sp else 34.sp,
                fontWeight = FontWeight.Black
            )
        }
        Text(
            text = "PLAY BIG, WIN BIGGER",
            color = GoldPrimary,
            fontSize = if (isSmall) 7.sp else 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.8.sp
        )
    }
}
