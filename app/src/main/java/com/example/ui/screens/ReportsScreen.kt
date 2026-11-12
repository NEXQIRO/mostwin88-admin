package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.DepositRequest
import com.example.data.model.Player
import com.example.data.model.WithdrawalRequest
import com.example.ui.theme.*

@Composable
fun ReportsScreen(
    players: List<Player>,
    deposits: List<DepositRequest>,
    withdrawals: List<WithdrawalRequest>,
    onExportReports: () -> Unit
) {
    val totalApprovedDeposits = deposits.filter { it.status == "Approved" }.sumOf { it.amount }
    val totalApprovedCount = deposits.count { it.status == "Approved" }
    val totalCompletedWithdrawals = withdrawals.filter { it.status == "Completed" }.sumOf { it.amount }
    val totalWithdrawalCount = withdrawals.count { it.status == "Completed" }
    val netCashMovement = totalApprovedDeposits - totalCompletedWithdrawals

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "FINANCIAL & OPERATIONAL AUDIT",
                    color = GoldPrimary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )

                Button(
                    onClick = onExportReports,
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.testTag("btn_export_audit")
                ) {
                    Icon(Icons.Default.Download, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Export Audit CSV", color = OnGold, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Summary Cards
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("PLATFORM FINANCIAL AUDIT STATEMENT", color = GoldPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column {
                            Text("Total Successful Deposits", color = TextMuted, fontSize = 11.sp)
                            Text("৳ ${String.format("%,.2f", totalApprovedDeposits)}", color = SuccessGreen, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                            Text("$totalApprovedCount approved transactions", color = TextDim, fontSize = 10.sp)
                        }

                        Column(horizontalAlignment = Alignment.End) {
                            Text("Total Paid Withdrawals", color = TextMuted, fontSize = 11.sp)
                            Text("৳ ${String.format("%,.2f", totalCompletedWithdrawals)}", color = AccentRed, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                            Text("$totalWithdrawalCount fulfilled payouts", color = TextDim, fontSize = 10.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    HorizontalDivider(color = GoldLineSubtle)

                    Spacer(modifier = Modifier.height(10.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Net Cash Flow (Inflow − Outflow):", color = TextMain, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Text(
                            text = (if (netCashMovement >= 0) "+৳ " else "-৳ ") + String.format("%,.2f", kotlin.math.abs(netCashMovement)),
                            color = if (netCashMovement >= 0) InfoBlue else AccentRed,
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                    }
                }
            }
        }

        item {
            Text("TOP PLAYER ACTIVITY AUDIT", color = TextMuted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }

        items(players) { p ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text(p.name, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        Text("UID: ${p.gameUid} • Wallet: ৳${p.walletBalance}", color = TextDim, fontSize = 10.sp)
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column(horizontalAlignment = Alignment.End) {
                            Text("Dep: ৳${String.format("%,.0f", p.totalDeposited)}", color = SuccessGreen, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            Text("Wth: ৳${String.format("%,.0f", p.totalWithdrawn)}", color = AccentRed, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}
